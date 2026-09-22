"""The sandbox launch contract for the official Grafana integrations."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.agent_observability import REQUIRED_ENV_KEYS, observability_env
from tests.runtime_helpers import make_opencode_server

CONNECTION = {
    "AGENTO11Y_ENDPOINT": "https://generations.example.test",
    "AGENTO11Y_AUTH_TENANT_ID": "123",
    "AGENTO11Y_AUTH_TOKEN": "test-secret",
    "AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp.example.test/otlp",
}


def test_unconfigured_is_a_noop():
    log = MagicMock()
    assert observability_env({}, harness="opencode", log=log) == {}
    log.warn.assert_not_called()


@pytest.mark.parametrize("missing", REQUIRED_ENV_KEYS)
def test_partial_connection_is_disabled_without_logging_secrets(missing):
    log = MagicMock()
    env = {**CONNECTION, missing: " "}
    assert observability_env(env, harness="opencode", log=log) == {}
    log.warn.assert_called_once_with("agento11y.disabled", missing_env_keys=[missing])
    assert "test-secret" not in str(log.mock_calls)


def test_full_capture_with_nested_repository_and_explicit_overrides():
    env = observability_env(
        {**CONNECTION, "REPO_OWNER": "group/subgroup", "REPO_NAME": "repo"},
        harness="opencode",
        log=MagicMock(),
    )
    assert env["AGENTO11Y_CONTENT_CAPTURE_MODE"] == "full"
    assert env["AGENTO11Y_TAGS"] == "repo=group/subgroup/repo"
    assert env["AGENTO11Y_AGENT_NAME"] == "open-inspect-opencode"
    assert env["AGENTO11Y_GUARDS_ENABLED"] == "false"
    assert env["AGENTO11Y_LOCAL"] == "false"
    override = observability_env(
        {**env, "AGENTO11Y_CONTENT_CAPTURE_MODE": "metadata_only", "AGENTO11Y_AGENT_VERSION": "v2"},
        harness="opencode",
        log=MagicMock(),
    )
    assert override["AGENTO11Y_CONTENT_CAPTURE_MODE"] == "metadata_only"
    assert override["AGENTO11Y_AGENT_VERSION"] == "v2"
    tagged = observability_env(
        {
            **CONNECTION,
            "REPO_OWNER": "group/subgroup",
            "REPO_NAME": "repo",
            "AGENTO11Y_TAGS": "team=dev",
        },
        harness="opencode",
        log=MagicMock(),
    )
    assert tagged["AGENTO11Y_TAGS"] == "repo=group/subgroup/repo,team=dev"


@pytest.mark.parametrize("installed", [True, False])
async def test_opencode_loads_local_plugin_with_credentials_only_in_child_env(
    tmp_path, monkeypatch, installed
):
    plugin = tmp_path / "plugin.js"
    if installed:
        plugin.write_text("export const Agento11yPlugin = async () => ({});")
    monkeypatch.setattr("sandbox_runtime.opencode_server.OPENCODE_PLUGIN", plugin)
    server = make_opencode_server({}, workspace_path=tmp_path)
    with (
        patch.dict("os.environ", CONNECTION, clear=True),
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    child_env = spawn.call_args.kwargs["env"]
    config = json.loads(child_env["OPENCODE_CONFIG_CONTENT"])
    assert "test-secret" not in child_env["OPENCODE_CONFIG_CONTENT"]
    assert child_env["AGENTO11Y_AUTH_TOKEN"] == "test-secret"
    if installed:
        assert config["plugin"] == [plugin.as_uri()]
        assert child_env["AGENTO11Y_CONTENT_CAPTURE_MODE"] == "full"
    else:
        assert "plugin" not in config
    assert spawn.call_args.args[:2] == ("opencode", "serve")


@pytest.mark.parametrize("export_failure", [False, True])
async def test_opencode_disposes_before_termination_even_if_export_fails(export_failure):
    server = make_opencode_server({})
    process = MagicMock(returncode=None)
    process.wait = AsyncMock(return_value=0)
    server._opencode_process = process
    server._observability_enabled = True

    async def dispose(*args, **kwargs):
        process.terminate.assert_not_called()
        if export_failure:
            raise httpx.ReadTimeout("export timed out")
        return httpx.Response(200, request=httpx.Request("POST", args[0]))

    with patch("sandbox_runtime.opencode_server.httpx.AsyncClient") as client_type:
        client = client_type.return_value.__aenter__.return_value
        client.post = AsyncMock(side_effect=dispose)
        await server.stop()
    assert client.post.call_args.args[0].endswith("/global/dispose")
    process.terminate.assert_called_once()
    process.wait.assert_awaited_once()
