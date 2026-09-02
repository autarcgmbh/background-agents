import asyncio
import signal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_sync import (
    DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
    DEFAULT_GIT_FETCH_TIMEOUT_SECONDS,
    RepositorySynchronizer,
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
    RepositorySyncTimeout,
)
from sandbox_runtime.runtime_config import BootMode


def _repository(tmp_path: Path, name: str = "app") -> RepoEntry:
    return RepoEntry(owner="acme", name=name, branch="main", path=tmp_path / name)


def _hung_process() -> MagicMock:
    async def communicate_forever() -> tuple[bytes, bytes]:
        await asyncio.Event().wait()
        return b"", b""

    process = MagicMock(returncode=None, pid=4321)
    process.communicate = AsyncMock(side_effect=communicate_forever)
    process.wait = AsyncMock(return_value=-signal.SIGKILL)
    return process


def test_git_operation_timeout_defaults_are_named() -> None:
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    assert synchronizer.clone_timeout_seconds == DEFAULT_GIT_CLONE_TIMEOUT_SECONDS
    assert synchronizer.fetch_timeout_seconds == DEFAULT_GIT_FETCH_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_hung_clone_times_out_and_cleans_up_process_group(tmp_path: Path) -> None:
    process = _hung_process()
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log, clone_timeout_seconds=0.01)
    repo = _repository(tmp_path)

    with (
        patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=process,
        ) as create_process,
        patch("sandbox_runtime.repository_sync.os.killpg") as kill_process_group,
        pytest.raises(RepositorySyncTimeout),
    ):
        await synchronizer._clone_repo(repo)

    kill_process_group.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()
    assert create_process.await_args.kwargs["start_new_session"] is True
    log.error.assert_called_once_with(
        "git.clone_timeout",
        repo_owner="acme",
        repo_name="app",
        timeout_seconds=0.01,
    )


@pytest.mark.asyncio
async def test_hung_fetch_times_out_and_cleans_up_process_group(tmp_path: Path) -> None:
    process = _hung_process()
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log, fetch_timeout_seconds=0.01)
    repo = _repository(tmp_path)
    repo.path.mkdir()

    with (
        patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=process,
        ) as create_process,
        patch("sandbox_runtime.repository_sync.os.killpg") as kill_process_group,
        pytest.raises(RepositorySyncTimeout),
    ):
        await synchronizer._fetch_branch(repo, repo.branch)

    kill_process_group.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()
    assert create_process.await_args.kwargs["start_new_session"] is True
    log.error.assert_called_once_with(
        "git.fetch_timeout",
        repo_owner="acme",
        repo_name="app",
        timeout_seconds=0.01,
    )


@pytest.mark.asyncio
async def test_multi_repository_sync_identifies_timed_out_member(tmp_path: Path) -> None:
    repositories = [_repository(tmp_path, "frontend"), _repository(tmp_path, "backend")]
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    async def sync_repo(repo: RepoEntry, _boot_mode: BootMode) -> bool:
        if repo.name == "backend":
            raise RepositorySyncTimeout
        return True

    synchronizer._sync_repo = AsyncMock(side_effect=sync_repo)

    result = await synchronizer.sync(repositories, BootMode.FRESH)

    assert result.outcomes == (
        RepositorySyncOutcome(repositories[0], RepositorySyncStatus.SUCCEEDED),
        RepositorySyncOutcome(repositories[1], RepositorySyncStatus.TIMED_OUT),
    )
    assert result.failures == (repositories[1],)
    assert result.timed_out == (repositories[1],)
    assert synchronizer._sync_repo.await_count == 2


def _completed_process() -> MagicMock:
    process = MagicMock(returncode=0, pid=4322)
    process.communicate = AsyncMock(return_value=(b"", b""))
    return process


@pytest.mark.asyncio
async def test_fetch_skips_tags(tmp_path: Path) -> None:
    """Nothing in the runtime resolves tags, and a long-lived repo has many."""
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    repo = _repository(tmp_path)
    repo.path.mkdir()

    with patch(
        "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
        new_callable=AsyncMock,
        return_value=_completed_process(),
    ) as create_process:
        assert await synchronizer._fetch_branch(repo, repo.branch)

    assert "--no-tags" in create_process.await_args.args


@pytest.mark.asyncio
async def test_fetch_logs_its_duration(tmp_path: Path) -> None:
    """The repo-image boot path is otherwise silent between dockerd and start.sh."""
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log)
    repo = _repository(tmp_path)
    repo.path.mkdir()

    with patch(
        "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
        new_callable=AsyncMock,
        return_value=_completed_process(),
    ):
        await synchronizer._fetch_branch(repo, repo.branch)

    events = {call.args[0]: call.kwargs for call in log.info.call_args_list}
    assert "duration_ms" in events["git.fetch_complete"]


@pytest.mark.asyncio
async def test_checkout_logs_its_duration(tmp_path: Path) -> None:
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log)
    repo = _repository(tmp_path)
    repo.path.mkdir()

    with patch(
        "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
        new_callable=AsyncMock,
        return_value=_completed_process(),
    ):
        await synchronizer._checkout_branch(repo, repo.branch)

    events = {call.args[0]: call.kwargs for call in log.info.call_args_list}
    assert "duration_ms" in events["git.checkout_complete"]


@pytest.mark.asyncio
async def test_repo_image_boot_reports_sync_duration(tmp_path: Path) -> None:
    """A repo-image boot logs the sync it used to pass over in silence."""
    from tests.runtime_helpers import make_repository_boot

    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
        clear=True,
    ):
        boot = make_repository_boot()
    boot.workspace_path = tmp_path
    boot.repo_path = tmp_path / "app"
    boot.repositories = boot._parse_repositories()
    boot.log = MagicMock()
    boot.synchronizer = MagicMock()
    boot.synchronizer.ensure_credentials_configured = AsyncMock()
    boot.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(tuple(boot.repositories), ())
    )
    boot.hooks = MagicMock()
    boot.hooks.run_start = AsyncMock(return_value=MagicMock(succeeded=True))
    boot.tunnel_environment = MagicMock()
    boot.tunnel_environment.wait_until_ready = AsyncMock()

    await boot.boot(BootMode.REPO_IMAGE, [])

    events = {call.args[0]: call.kwargs for call in boot.log.info.call_args_list}
    assert "duration_ms" in events["git.sync_complete"]
    assert events["git.sync_complete"]["boot_mode"] == "repo_image"
