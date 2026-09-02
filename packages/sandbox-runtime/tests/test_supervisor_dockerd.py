"""dockerd startup policy: who owns the daemon, and standing down when someone does.

Only Modal sandboxes need the supervisor to start dockerd — they run this
process as their entrypoint with no init. E2B runs systemd, whose docker-ce unit
already owns one, and launching a second daemon there just exits with "process
with PID N is still running", so every skip path below matters as much as the
start path.
"""

from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import DOCKERD_LOG_FILE_PATH
from sandbox_runtime.supervisor import SandboxSupervisor


def _supervisor():
    """A stub carrying only what _start_docker_daemon touches.

    The already-running probe is bound from the real class rather than mocked,
    so these cases exercise the pid-file and `docker info` logic itself.
    """
    stub = SimpleNamespace(log=MagicMock(), _docker_daemon=None)
    stub._docker_daemon_already_running = partial(
        SandboxSupervisor._docker_daemon_already_running, stub
    )
    return stub


async def _start(supervisor):
    await SandboxSupervisor._start_docker_daemon(supervisor)


@pytest.mark.asyncio
async def test_skips_when_dockerd_is_not_installed():
    supervisor = _supervisor()

    with patch("sandbox_runtime.supervisor.shutil.which", return_value=None):
        await _start(supervisor)

    assert supervisor._docker_daemon is None
    assert supervisor.log.info.call_args.args == ("dockerd.skip",)
    assert supervisor.log.info.call_args.kwargs["reason"] == "not_installed"


@pytest.mark.asyncio
async def test_stands_down_when_a_pid_file_shows_a_daemon_already_owns_the_lock():
    supervisor = _supervisor()

    with (
        patch("sandbox_runtime.supervisor.shutil.which", return_value="/usr/bin/dockerd"),
        patch("sandbox_runtime.supervisor.Path.exists", return_value=True),
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as spawn,
    ):
        await _start(supervisor)

    assert supervisor._docker_daemon is None
    spawn.assert_not_called()
    assert supervisor.log.info.call_args.kwargs["reason"] == "already_running"


@pytest.mark.asyncio
async def test_stands_down_when_docker_info_answers():
    supervisor = _supervisor()
    probe = MagicMock()
    probe.wait = AsyncMock(return_value=0)

    with (
        patch("sandbox_runtime.supervisor.shutil.which", return_value="/usr/bin/dockerd"),
        patch("sandbox_runtime.supervisor.Path.exists", return_value=False),
        patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=probe
        ) as spawn,
    ):
        await _start(supervisor)

    assert supervisor._docker_daemon is None
    # One call only: the `docker info` probe, never a second dockerd.
    assert spawn.await_count == 1
    assert spawn.await_args.args[:2] == ("docker", "info")
    assert supervisor.log.info.call_args.kwargs["reason"] == "already_running"


@pytest.mark.asyncio
async def test_starts_the_daemon_when_nothing_else_has(tmp_path):
    supervisor = _supervisor()
    probe = MagicMock()
    probe.wait = AsyncMock(return_value=1)  # no daemon answering
    daemon = MagicMock()
    daemon.pid = 4321
    log_path = tmp_path / "oi-dockerd.log"

    with (
        patch("sandbox_runtime.supervisor.shutil.which", return_value="/usr/bin/dockerd"),
        patch("sandbox_runtime.supervisor.Path.exists", return_value=False),
        patch(
            "sandbox_runtime.supervisor.DOCKERD_LOG_FILE_PATH",
            str(log_path),
        ),
        patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=[probe, daemon],
        ) as spawn,
    ):
        await _start(supervisor)

    assert supervisor._docker_daemon is daemon
    assert spawn.await_args_list[1].args == ("dockerd",)
    # Detached, so the daemon outlives the supervisor's own process group work.
    assert spawn.await_args_list[1].kwargs["start_new_session"] is True
    assert supervisor.log.info.call_args.args == ("dockerd.started",)
    assert supervisor.log.info.call_args.kwargs["pid"] == 4321


@pytest.mark.asyncio
async def test_a_failed_start_is_logged_and_never_fatal():
    supervisor = _supervisor()
    probe = MagicMock()
    probe.wait = AsyncMock(return_value=1)

    with (
        patch("sandbox_runtime.supervisor.shutil.which", return_value="/usr/bin/dockerd"),
        patch("sandbox_runtime.supervisor.Path.exists", return_value=False),
        patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=[probe, OSError("no such file")],
        ),
    ):
        await _start(supervisor)

    assert supervisor._docker_daemon is None
    assert supervisor.log.warn.call_args.args == ("dockerd.start_failed",)


def test_the_daemon_log_lives_under_tmp():
    # Written before any repository checkout exists, and it must not end up
    # inside /workspace where a snapshot would bake it into the image.
    assert DOCKERD_LOG_FILE_PATH.startswith("/tmp/")
