"""Environment and installed paths for Grafana's official coding-agent plugins."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .log_config import StructuredLogger

OPENCODE_PLUGIN = Path(
    "/opt/openinspect/tools/node_modules/@grafana/agento11y-opencode/dist/index.js"
)
CLAUDE_PLUGIN = Path("/opt/openinspect/agento11y/claude-code")
REQUIRED_ENV_KEYS = (
    "AGENTO11Y_ENDPOINT",
    "AGENTO11Y_AUTH_TENANT_ID",
    "AGENTO11Y_AUTH_TOKEN",
    "AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT",
)
SHUTDOWN_TIMEOUT_SECONDS = 20


def observability_env(
    environ: Mapping[str, str], *, harness: str, log: StructuredLogger
) -> dict[str, str]:
    """Enable both export channels together; absent configuration is a no-op.

    Credentials stay in the child environment, never in generated agent config.
    The plugins own provider creation, capture, redaction, and export lifecycle.
    """
    if not any(environ.get(key, "").strip() for key in REQUIRED_ENV_KEYS):
        return {}
    missing = [key for key in REQUIRED_ENV_KEYS if not environ.get(key, "").strip()]
    if missing:
        log.warn("agento11y.disabled", missing_env_keys=missing)
        return {}

    defaults = {
        "AGENTO11Y_CONTENT_CAPTURE_MODE": "full",
        "AGENTO11Y_AGENT_NAME": f"open-inspect-{harness}",
        "AGENTO11Y_AUTO_CODING_AGENT_TAGS": "true",
        "AGENTO11Y_AUTO_CODING_AGENT_TAGS_NAMES": "user,repo",
        "AGENTO11Y_LOCAL": "false",
        "AGENTO11Y_GUARDS_ENABLED": "false",
        "AGENTO11Y_AUTO_UPDATE": "false",
    }
    owner, repo = environ.get("REPO_OWNER"), environ.get("REPO_NAME")
    repo_tag = f"repo={owner}/{repo}" if owner and repo else "repo=none"
    configured = {
        key: value
        for key, value in environ.items()
        if key.startswith("AGENTO11Y_") or key.startswith("OTEL_EXPORTER_OTLP_")
    }
    return {
        **configured,
        **{key: environ.get(key, "").strip() or value for key, value in defaults.items()},
        "AGENTO11Y_TAGS": ",".join(
            value for value in (repo_tag, environ.get("AGENTO11Y_TAGS", "").strip()) if value
        ),
    }
