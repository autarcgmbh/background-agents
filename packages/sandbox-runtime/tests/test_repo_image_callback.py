import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    CALLBACK_USER_AGENT,
    ERROR_MESSAGE_MAX_CHARS,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
    RepoImageBuildCallback,
    RepoImageCallbackMisconfigured,
)


def test_from_env_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv(BUILD_ID_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(FAILURE_CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)
    monkeypatch.delenv(PROVIDER_SESSION_ID_ENV, raising=False)

    assert RepoImageBuildCallback.from_env() is None


def test_from_env_rejects_present_but_empty_configuration(monkeypatch):
    monkeypatch.setenv(CALLBACK_URL_ENV, "")
    monkeypatch.delenv(BUILD_ID_ENV, raising=False)
    monkeypatch.delenv(FAILURE_CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)
    monkeypatch.delenv(PROVIDER_SESSION_ID_ENV, raising=False)

    with pytest.raises(RepoImageCallbackMisconfigured):
        RepoImageBuildCallback.from_env()


def test_from_env_rejects_partial_configuration(monkeypatch):
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/repo-images/build-failed")
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")
    monkeypatch.setenv(PROVIDER_SESSION_ID_ENV, "vercel-session-1")

    with pytest.raises(RepoImageCallbackMisconfigured):
        RepoImageBuildCallback.from_env(logger)
    logger.error.assert_called_once()


def test_from_env_rejects_missing_failure_callback_url(monkeypatch):
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/repo-images/build-complete")
    monkeypatch.delenv(FAILURE_CALLBACK_URL_ENV, raising=False)
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")
    monkeypatch.setenv(PROVIDER_SESSION_ID_ENV, "vercel-session-1")

    with pytest.raises(RepoImageCallbackMisconfigured):
        RepoImageBuildCallback.from_env(logger)
    logger.error.assert_called_once()


def test_from_env_rejects_missing_provider_session_id(monkeypatch):
    # Every provider sets the session id unconditionally at spawn; the control
    # plane rejects callbacks without it, so fail fast at boot instead of
    # 400-and-retrying silently.
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/repo-images/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/repo-images/build-failed")
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")
    monkeypatch.delenv(PROVIDER_SESSION_ID_ENV, raising=False)

    with pytest.raises(RepoImageCallbackMisconfigured) as excinfo:
        RepoImageBuildCallback.from_env(logger)
    assert PROVIDER_SESSION_ID_ENV in str(excinfo.value)
    logger.error.assert_called_once()


def test_from_env_reads_both_callback_urls(monkeypatch):
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/repo-images/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/repo-images/build-failed")
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")
    monkeypatch.setenv(PROVIDER_SESSION_ID_ENV, "vercel-session-1")

    reporter = RepoImageBuildCallback.from_env()
    assert reporter is not None
    assert reporter.callback_url == "https://cp.test/repo-images/build-complete"
    assert reporter.failure_callback_url == "https://cp.test/repo-images/build-failed"
    assert reporter.provider_session_id == "vercel-session-1"


@pytest.mark.asyncio
async def test_report_success_posts_authenticated_payload(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)

    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        failure_callback_url="https://cp.test/repo-images/build-failed",
        token="callback-token",
        provider_session_id="vercel-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_success(
        build_duration_seconds=12.3456,
        repository_shas=[{"repoOwner": "acme", "repoName": "web", "baseSha": "abc123"}],
        runtime_version="v99-test",
    )

    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://cp.test/repo-images/build-complete"
    assert request.headers["authorization"] == "Bearer callback-token"
    assert request.headers["user-agent"] == CALLBACK_USER_AGENT
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {
        "build_id": "build-1",
        "build_duration_seconds": 12.346,
        "repository_shas": [{"repoOwner": "acme", "repoName": "web", "baseSha": "abc123"}],
        "runtime_version": "v99-test",
        "provider_session_id": "vercel-session-1",
    }


@pytest.mark.asyncio
async def test_report_failure_posts_to_failed_endpoint_and_truncates_error(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)
    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        failure_callback_url="https://cp.test/repo-images/build-failed",
        token="callback-token",
        provider_session_id="vercel-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_failure("x" * (ERROR_MESSAGE_MAX_CHARS + 100))

    assert str(requests[0].url) == "https://cp.test/repo-images/build-failed"
    assert json.loads(requests[0].content) == {
        "build_id": "build-1",
        "error": "x" * ERROR_MESSAGE_MAX_CHARS,
        "provider_session_id": "vercel-session-1",
    }


@pytest.mark.asyncio
async def test_report_failure_appends_hook_output_tail(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)
    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        failure_callback_url="https://cp.test/repo-images/build-failed",
        token="callback-token",
        provider_session_id="modal-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_failure("setup hook failed", output_tail="line one\nline two")

    assert json.loads(requests[0].content)["error"] == ("setup hook failed\n\nline one\nline two")


@pytest.mark.asyncio
async def test_report_failure_keeps_cause_and_trims_the_tail_when_over_budget(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)
    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        failure_callback_url="https://cp.test/repo-images/build-failed",
        token="callback-token",
        provider_session_id="modal-session-1",
        logger=MagicMock(),
    )
    cause = "setup hook failed"

    assert await reporter.report_failure(
        cause, output_tail="head" + ("y" * ERROR_MESSAGE_MAX_CHARS) + "the actual error"
    )

    error = json.loads(requests[0].content)["error"]
    assert len(error) == ERROR_MESSAGE_MAX_CHARS
    # The cause survives whole and the tail loses its oldest lines, so the
    # reason the script stopped is still the last thing in the message.
    assert error.startswith(f"{cause}\n\n")
    assert error.endswith("the actual error")
    assert "head" not in error


@pytest.mark.asyncio
async def test_retries_transient_callback_failures(monkeypatch):
    responses = [httpx.Response(503), httpx.Response(200)]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses.pop(0)

    _patch_async_client(monkeypatch, handler)
    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.repo_image_callback.asyncio.sleep", sleep)

    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        failure_callback_url="https://cp.test/repo-images/build-failed",
        token="callback-token",
        provider_session_id="vercel-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_success(
        build_duration_seconds=1.0,
        repository_shas=[{"repoOwner": "acme", "repoName": "web", "baseSha": "abc123"}],
        runtime_version="v99-test",
    )
    assert len(requests) == 2
    sleep.assert_awaited_once_with(2)


def _patch_async_client(monkeypatch, handler):
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr("sandbox_runtime.repo_image_callback.httpx.AsyncClient", factory)
