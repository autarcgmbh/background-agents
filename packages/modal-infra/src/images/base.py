"""
Base image definition for Open-Inspect sandboxes.

This image provides a complete development environment with:
- Debian slim base with git, curl, build-essential
- Node.js 24, corepack-pinned pnpm, Bun runtime
- Go toolchain with golangci-lint and air
- Python 3.12 with uv
- Workload CLIs: gh, op, stripe, mkcert, gcx, posthog-cli, psql
- OpenCode CLI pre-installed
- agent-browser CLI with headless Chrome for browser automation
- ffmpeg for browser video encoding
- Docker engine, for repository hooks that bring up service containers
- Shared, pre-warmed corepack/pnpm/turbo/Go caches
- Sandbox entrypoint and bridge code

Docker only works because sandboxes run on Modal's VM runtime, not gVisor — see
MODAL_EXPERIMENTAL_OPTIONS in src/sandbox/manager.py. The daemon is started at
boot by the sandbox-runtime supervisor, never by this image.

Commands that span lines are joined with an explicit `+`: implicit concatenation
of adjacent literals hides a missing separator in a shell command, and type
checkers flag it (basedpyright reportImplicitStringConcatenation).
"""

from pathlib import Path

import modal

import sandbox_runtime
from sandbox_runtime.runtime_manifest import RUNTIME_VERSION

# Get the path to the sandbox runtime code (provider-agnostic)
SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent

# OpenCode version to install.
#
# OpenCode restored `/event` stream context in 1.14.50 and fixed the remaining
# eager-subscription race in 1.15.5. Keep the CLI and plugin on the same pin.
#
# Never pin below 1.18.15: OpenCode's message-ID counter is a 48-bit truncation
# of `Date.now() * 0x1000`, so it wraps roughly every 795 days (most recently
# 2026-08-14) and IDs minted afterwards sort below every older one. Earlier
# releases order the turn loop by comparing those IDs as strings, which makes
# any session carrying pre-wraparound history exit the loop without calling the
# model. 1.18.15 orders by message creation time instead.
OPENCODE_VERSION = "1.18.25"

# code-server version to install (pinned for reproducible images)
CODE_SERVER_VERSION = "4.109.5"

# agent-browser version to install (pinned for reproducible images)
AGENT_BROWSER_VERSION = "0.21.2"

# ttyd version to install (pinned for reproducible images)
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

NODE_MAJOR = "24"
PNPM_VERSION = "11.11.0"
GO_VERSION = "1.25.8"
GOLANGCI_LINT_VERSION = "2.6.2"
AIR_VERSION = "v1.62.0"
OP_VERSION = "2.39.0"
STRIPE_CLI_VERSION = "1.50.6"
# Stripe ships its agent skills inside a Claude Code plugin sourced from this
# repo, pinned to the commit the official plugin marketplace resolves for it.
STRIPE_AI_SKILLS_REF = "e8f9aee6f9a34a633243e632e650401a76c36c41"
MKCERT_VERSION = "v1.4.4"
GCX_VERSION = "1.2.0"
POSTHOG_CLI_VERSION = "0.16.0"
POSTHOG_WIZARD_VERSION = "2.70.1"

COREPACK_HOME = "/opt/corepack"
PNPM_HOME = "/opt/pnpm-home"
PNPM_STORE_DIR = "/opt/pnpm-store"
TURBO_CACHE_DIR = "/opt/turbo-cache"
GOPATH = "/opt/go"

# Home of the agent account. The Modal sandbox runs as root, so the skills and
# rules baked below land here rather than in E2B's /home/user.
SANDBOX_HOME = "/root"

# Cache buster - change this to force Modal image rebuild.
# The numeric generation is one sequence shared by every image-build provider,
# and MIN_REBUILD_RUNTIME_VERSION gates which prebuilt images get rebuilt onto
# it, so bump every provider's label together.
# v59: OpenCode past the message-ID wraparound (see OPENCODE_VERSION)
# v60: generic provider-account token broker plugin
# v61: account/init helpers and /usr/sbin on PATH
# v62: Stripe agent skills and a system ripgrep baked in
CACHE_BUSTER = RUNTIME_VERSION

# Base image with all development tools
base_image = (
    modal.Image.debian_slim(python_version="3.12")
    # System packages
    .apt_install(
        "git",
        "curl",
        "build-essential",
        "ca-certificates",
        "gnupg",
        "openssh-client",
        "jq",
        "unzip",  # Required for Bun installation
        # Account and init helpers. debian_slim ships without them, so nothing in
        # a sandbox can create a system user, and services that refuse to run as
        # root (Elasticsearch, Postgres, nginx) have no account to drop to.
        "passwd",
        "adduser",
        "sysvinit-utils",
        "procps",
        # sudo is a no-op for root, but repository hooks are written against
        # sandboxes that run non-root and call it unconditionally.
        "sudo",
        "postgresql-client",
        # OpenCode downloads its own ripgrep from GitHub on the first search
        # otherwise, putting a release download on the critical path of the
        # agent's first grep. It skips that when rg is already on PATH.
        "ripgrep",
        # Docker's own dependencies: iptables for its bridge network rules,
        # uidmap and fuse-overlayfs for the storage and namespace paths it falls
        # back to. Usable only under the VM runtime (see the module docstring).
        "iptables",
        "uidmap",
        "fuse-overlayfs",
        "ffmpeg",
        "xvfb",
        "fluxbox",
        "x11vnc",
        "websockify",
        "novnc",
        # Shared libraries required by headless Chromium
        "libnss3",
        # certutil, which mkcert needs to install its CA into the NSS store
        "libnss3-tools",
        "libnspr4",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libxkbcommon0",
        "libxcomposite1",
        "libxdamage1",
        "libxfixes3",
        "libxrandr2",
        "libgbm1",
        "libasound2",
        "libpango-1.0-0",
        "libcairo2",
    )
    .env(
        {
            "COREPACK_HOME": COREPACK_HOME,
            "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "PNPM_HOME": PNPM_HOME,
            "GOPATH": GOPATH,
            "GOMODCACHE": f"{GOPATH}/pkg/mod",
            "GOTOOLCHAIN": "local",
            "POSTHOG_CLI_HOST": "https://eu.posthog.com",
        }
    )
    # Shared caches. A prebuilt repo image warms these during its build and the
    # snapshot carries them into every session.
    .run_commands(
        f"mkdir -p {COREPACK_HOME} {PNPM_HOME} {PNPM_STORE_DIR} {TURBO_CACHE_DIR}"
        + f" {GOPATH}/bin {GOPATH}/pkg/mod",
        f"chmod -R 1777 {PNPM_HOME} {PNPM_STORE_DIR} {TURBO_CACHE_DIR} {GOPATH}",
    )
    # Docker engine, for repositories whose setup/start hooks bring up service
    # containers. Taken from Docker's own apt repository rather than Debian's
    # docker.io, which ships neither the compose v2 nor the buildx plugin — and
    # `docker compose` (not `docker-compose`) is what those hooks invoke.
    # dockerd is started by the supervisor at boot, never by this image.
    .run_commands(
        "install -m 0755 -d /etc/apt/keyrings",
        "curl -fsSL https://download.docker.com/linux/debian/gpg"
        + " -o /etc/apt/keyrings/docker.asc",
        "chmod a+r /etc/apt/keyrings/docker.asc",
        'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc]'
        + ' https://download.docker.com/linux/debian bookworm stable"'
        + " > /etc/apt/sources.list.d/docker.list",
        "apt-get update",
        "apt-get install -y docker-ce docker-ce-cli containerd.io"
        + " docker-buildx-plugin docker-compose-plugin",
        "rm -rf /var/lib/apt/lists/*",
    )
    # Install GitHub CLI (for agent-direct GitHub interaction via gh API)
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg"
        + " | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg]"
        + " https://cli.github.com/packages stable main'"
        + " > /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    )
    # Install Node.js
    .run_commands(
        f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash -",
        "apt-get install -y nodejs",
        # Verify installation
        "node --version",
        "npm --version",
    )
    # Install pnpm and Bun
    .run_commands(
        "corepack enable",
        f"corepack install -g pnpm@{PNPM_VERSION}",
        # Install Bun
        "curl -fsSL https://bun.sh/install | bash",
        # Add Bun to PATH for subsequent commands
        'echo "export BUN_INSTALL="$HOME/.bun"" >> /etc/profile.d/bun.sh',
        'echo "export PATH="$BUN_INSTALL/bin:$PATH"" >> /etc/profile.d/bun.sh',
    )
    # Install Go toolchain. Symlinked into /usr/local/bin rather than extending PATH, so
    # the runtime PATH stays a plain superset of Debian's default.
    .run_commands(
        # Fetched from dl.google.com, the host go.dev/dl redirects to: its redirect
        # handler intermittently 500s, which fails the whole image build.
        f"curl -fsSL --retry 3 --retry-all-errors https://dl.google.com/go/go{GO_VERSION}.linux-amd64.tar.gz"
        + " | tar -C /usr/local -xzf -",
        "ln -sf /usr/local/go/bin/go /usr/local/bin/go",
        "ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
        "curl -fsSL https://github.com/golangci/golangci-lint/releases/download/"
        + f"v{GOLANGCI_LINT_VERSION}/golangci-lint-{GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz"
        + " | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/golangci-lint'",
        "chmod +x /usr/local/bin/golangci-lint",
        # Build air under a throwaway GOPATH so the shared module cache stays a
        # session-warmed artifact rather than image-build spill.
        "GOPATH=/tmp/gobuild GOBIN=/usr/local/bin GOFLAGS=-mod=mod"
        + f" go install github.com/air-verse/air@{AIR_VERSION}",
        "rm -rf /tmp/gobuild",
    )
    # Workload CLIs. No credentials are baked into any of them: each resolves its
    # token per invocation from repository secrets, so a session authenticates
    # without an interactive login.
    .run_commands(
        f"curl -fsSL https://cache.agilebits.com/dist/1P/op2/pkg/v{OP_VERSION}"
        + f"/op_linux_amd64_v{OP_VERSION}.zip -o /tmp/op.zip",
        "unzip -o /tmp/op.zip -d /usr/local/bin op",
        "chmod +x /usr/local/bin/op",
        "rm /tmp/op.zip",
        f"curl -fsSL https://github.com/stripe/stripe-cli/releases/download/v{STRIPE_CLI_VERSION}"
        + f"/stripe_{STRIPE_CLI_VERSION}_linux_x86_64.tar.gz"
        + " | tar -C /usr/local/bin -xzf - stripe",
        "chmod +x /usr/local/bin/stripe",
        "curl -fsSL -o /usr/local/bin/mkcert"
        + f" https://github.com/FiloSottile/mkcert/releases/download/{MKCERT_VERSION}"
        + f"/mkcert-{MKCERT_VERSION}-linux-amd64",
        "chmod +x /usr/local/bin/mkcert",
        f"curl -fsSL https://github.com/grafana/gcx/releases/download/v{GCX_VERSION}"
        + f"/gcx_{GCX_VERSION}_linux_amd64.tar.gz | tar -C /usr/local/bin -xzf - gcx",
        "chmod +x /usr/local/bin/gcx",
        "curl -fsSL https://github.com/PostHog/posthog/releases/download/posthog-cli"
        + f"/v{POSTHOG_CLI_VERSION}/posthog-cli-x86_64-unknown-linux-gnu.tar.gz"
        + " | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/posthog-cli'",
        "chmod +x /usr/local/bin/posthog-cli",
    )
    # Install Python tools
    .pip_install(
        "uv",
        "httpx",
        "websockets",
        "pydantic>=2.0",  # Required for sandbox types
        "PyJWT[crypto]",  # For GitHub App token generation (includes cryptography)
    )
    # Install OpenCode CLI and plugin for custom tools
    # CACHE_BUSTER is embedded in a no-op echo so Modal invalidates this layer on bump.
    .run_commands(
        f"echo 'cache: {CACHE_BUSTER}' > /dev/null",
        f"npm install -g opencode-ai@{OPENCODE_VERSION}",
        "opencode --version || echo 'OpenCode installed'",
        # Install @opencode-ai/plugin globally for custom tools
        # This ensures tools can import the plugin without needing to run bun add
        f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
    )
    # Pre-build OpenCode plugin deps into a staging directory.
    # At boot, _install_tools() copies these into .opencode/ so that
    # OpenCode's Npm.install() finds package-lock.json in sync and skips
    # the slow arborist reify() call (2-22s) that would otherwise block
    # the first prompt and exceed the bridge's HTTP timeout.
    #
    # Also bake the same tree into OpenCode's GLOBAL config dir. OpenCode installs
    # @opencode-ai/plugin into every config directory it discovers — including the
    # global one (HOME=/root, so ~/.config/opencode), which it creates empty on
    # startup — so without this the runtime _seed_global_opencode_deps() pays a
    # multi-second node_modules copy on every boot. Baking it makes that seed a
    # no-op (it skips when node_modules already exists). See #767 / #790.
    .run_commands(
        "mkdir -p /app/opencode-deps",
        # Pin staged plugin to OPENCODE_VERSION so the pre-staged tree copied
        # into .opencode/ at boot matches the globally installed plugin (#567).
        'echo \'{"name":"opencode-tools","type":"module",'
        + f'"dependencies":{{"@opencode-ai/plugin":"{OPENCODE_VERSION}"}}}}\''
        + " > /app/opencode-deps/package.json",
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
        # Bake the in-sync tree into the global config dir so the runtime seed is a no-op.
        f"mkdir -p {SANDBOX_HOME}/.config/opencode",
        f"cp -a /app/opencode-deps/. {SANDBOX_HOME}/.config/opencode/",
    )
    # Agent skills and rules baked into the runtime HOME: gcx ships the Grafana
    # skills, posthog-cli its AGENTS.md guidance, and the PostHog wizard rides
    # along as a global npm install.
    .run_commands(
        f"npm install -g @posthog/wizard@{POSTHOG_WIZARD_VERSION}",
        f"gcx agent skills install --all --dir {SANDBOX_HOME}/.agents",
        f"posthog-cli api agents-md install --path {SANDBOX_HOME}/.config/opencode/AGENTS.md",
    )
    # Stripe's agent skills ride inside its Claude Code plugin, and
    # `stripe agent setup` can only install into claude-code, codex or cursor —
    # none of which run here. Copy the plugin's skill tree into the same global
    # agent-compatible directory gcx uses, which is one of the trees OpenCode
    # loads skills from.
    .run_commands(
        "git init -q /tmp/stripe-ai",
        "cd /tmp/stripe-ai"
        " && git remote add origin https://github.com/stripe/ai.git"
        f" && git fetch -q --depth 1 origin {STRIPE_AI_SKILLS_REF}"
        " && git checkout -q FETCH_HEAD",
        f"mkdir -p {SANDBOX_HOME}/.agents/skills",
        f"cp -a /tmp/stripe-ai/providers/claude/plugin/skills/. {SANDBOX_HOME}/.agents/skills/",
        "rm -rf /tmp/stripe-ai",
    )
    # Install code-server for browser-based VS Code editing (direct .deb from GitHub releases)
    .run_commands(
        "curl -fsSL -o /tmp/code-server.deb"
        + f" https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}"
        + f"/code-server_{CODE_SERVER_VERSION}_amd64.deb",
        "dpkg -i /tmp/code-server.deb",
        "rm /tmp/code-server.deb",
        "code-server --version",
    )
    # Install ttyd web terminal (direct binary from GitHub releases)
    .run_commands(
        "curl -fsSL -o /usr/local/bin/ttyd"
        + f" https://github.com/tsl0922/ttyd/releases/download/{TTYD_VERSION}"
        + "/ttyd.x86_64",
        f'echo "{TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -',
        "chmod +x /usr/local/bin/ttyd",
        "ttyd --version",
    )
    # Install agent-browser CLI and download Chromium
    .run_commands(
        f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
        "agent-browser install",
        "agent-browser --version",
    )
    # Create working directories
    .run_commands(
        "mkdir -p /workspace",
        "mkdir -p /app/plugins",
        "mkdir -p /tmp/opencode",
        "echo 'Image rebuilt at: v21-force-rebuild' > /app/image-version.txt",
    )
    # Install the git credential helper shim.
    #
    # Each `git` invocation in the sandbox runs this shim, which delegates to
    # the sandbox-runtime helper module. The helper talks to the control plane
    # to mint fresh per-request credentials, so git operations no longer rely
    # on a 1h-TTL token captured at sandbox creation time. Configured at the
    # system level so it applies before entrypoint.py has a chance to run
    # (e.g. when restoring a snapshot whose first action is a `git fetch`).
    .run_commands(
        "printf '%s\\n'"
        + " '#!/bin/sh'"
        + " 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
        + " > /usr/local/bin/oi-git-credentials",
        "chmod 0755 /usr/local/bin/oi-git-credentials",
        "git config --system credential.helper /usr/local/bin/oi-git-credentials",
        # Pass the repo path to the helper so it can scope credentials to the
        # session repo, not just the host.
        "git config --system credential.useHttpPath true",
    )
    .run_commands(
        f'case "$(node --version)" in v{NODE_MAJOR}.*) ;; *) exit 1 ;; esac',
        f'test "$(COREPACK_HOME={COREPACK_HOME} pnpm --version)" = "{PNPM_VERSION}"',
        f'test "$(go env GOVERSION)" = "go{GO_VERSION}"',
        "for t in gofmt golangci-lint air op stripe mkcert gcx psql sudo dockerd docker;"
        + ' do command -v "$t" > /dev/null || exit 1; done',
        # The compose plugin resolves only as a `docker` subcommand, so its
        # absence would not show up in the `command -v` sweep above.
        "docker compose version",
        f'test "$(posthog-cli --version)" = "posthog-cli {POSTHOG_CLI_VERSION}"',
        "command -v wizard",
        f"test -d {SANDBOX_HOME}/.agents/skills/debug-with-grafana",
        f"test -f {SANDBOX_HOME}/.agents/skills/stripe-best-practices/SKILL.md",
        f"grep -q posthog-cli {SANDBOX_HOME}/.config/opencode/AGENTS.md",
        "test -d /app/opencode-deps/node_modules",
        f"test -w {PNPM_STORE_DIR}",
        f"test -w {TURBO_CACHE_DIR}",
        f"test -w {GOPATH}",
    )
    # Set environment variables (including cache buster to force rebuild)
    .env(
        {
            "HOME": SANDBOX_HOME,
            "NODE_ENV": "development",
            # /usr/sbin and /sbin carry useradd, service, and daemons like nginx.
            # Sandbox commands run in non-interactive, non-login shells that never
            # source /etc/profile, so without them on PATH those commands fail with
            # "command not found" rather than anything that names the real problem.
            "PATH": (
                f"{SANDBOX_HOME}/.bun/bin:{PNPM_HOME}:{GOPATH}/bin"
                + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            ),
            "PYTHONPATH": "/app",
            "SANDBOX_VERSION": CACHE_BUSTER,
            # NODE_PATH for globally installed modules (used by custom tools)
            "NODE_PATH": "/usr/lib/node_modules",
        }
    )
    # Add sandbox runtime code to the image (provider-agnostic bridge, entrypoint, tools, plugins)
    .add_local_dir(
        str(SANDBOX_RUNTIME_DIR),
        remote_path="/app/sandbox_runtime",
    )
)
