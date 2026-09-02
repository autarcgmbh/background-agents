# Open-Inspect E2B sandbox template.
#
# Mirrors the toolchain pinned in packages/daytona-infra/src/toolchain.py so an
# E2B sandbox boots the same sandbox-runtime supervisor that Modal and Daytona use.
# Keep the versions below in sync with toolchain.py.
#
# Built remotely on E2B (amd64) via the Template SDK — see build-template.py,
# which stages packages/sandbox-runtime/src/sandbox_runtime and applies the COPY /
# WORKDIR / start-command steps programmatically (API-key auth, no access token).
#
# The template runs nothing of its own (its start command is an inert sleep —
# see build-template.py): the control plane starts the supervisor entrypoint
# via envd on every sandbox create, with per-sandbox env from the create call.

FROM python:3.12-slim-bookworm

# Pinned toolchain versions (keep in sync with daytona-infra/src/toolchain.py).
ARG OPENCODE_VERSION=1.18.18
ARG CODE_SERVER_VERSION=4.109.5
ARG AGENT_BROWSER_VERSION=0.21.2
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55

ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.11.0
ARG GO_VERSION=1.25.8
ARG GOLANGCI_LINT_VERSION=2.6.2
ARG AIR_VERSION=v1.62.0
ARG OP_VERSION=2.35.0-beta.01
ARG STRIPE_CLI_VERSION=1.40.9
ARG MKCERT_VERSION=v1.4.4
ARG GCX_VERSION=1.2.0
ARG POSTHOG_CLI_VERSION=0.16.0
ARG POSTHOG_WIZARD_VERSION=2.70.1

# $HOME is /root at build time and /home/user at runtime. COREPACK_HOME is re-pinned at
# runtime by E2B_SANDBOX_ENV
ENV COREPACK_HOME=/opt/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# System packages: git/build toolchain + browser and VNC/noVNC dependencies.
RUN apt-get update \
  && apt-get install -y git curl build-essential ca-certificates gnupg \
     openssh-client jq unzip libnss3 libnss3-tools libnspr4 libatk1.0-0 \
     libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
     libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
     libpango-1.0-0 libcairo2 ffmpeg xvfb fluxbox x11vnc websockify novnc \
     sudo passwd adduser procps sysvinit-utils iptables uidmap fuse-overlayfs \
     postgresql-client \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install -y nodejs \
  && corepack enable \
  && corepack install -g "pnpm@${PNPM_VERSION}" \
  # The runtime `user` must be able to read what corepack unpacked as root.
  && chmod -R a+rX /opt/corepack \
  # Install bun system-wide (not /root/.bun, which the runtime `user` can't read).
  && curl -fsSL https://bun.sh/install \
     | BUN_INSTALL=/usr/local bash \
  && python -m pip install --upgrade pip

# Passwordless sudo for E2B's non-root runtime account, so .openinspect/start.sh
# can bring up dockerd. E2B creates `user` in its own layer, so this is a
# name-based grant for an account that does not exist yet at build time.
RUN printf '%s\n' 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oi-user \
  && chmod 0440 /etc/sudoers.d/oi-user

# Docker engine, for repositories whose setup/start hooks bring up service
# containers. dockerd is started by the boot hook, never by this image.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
     -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y docker-ce docker-ce-cli containerd.io \
     docker-buildx-plugin docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain. Symlinked into /usr/local/bin rather than extending PATH, so the
# runtime PATH stays a plain superset of Debian's default.
# GOTOOLCHAIN=local (pinned at runtime in E2B_SANDBOX_ENV) stops a `toolchain`
# directive in a go.mod from downloading a second SDK on first build.
# dl.google.com is the host go.dev/dl redirects to; its redirect handler
# intermittently 500s, which fails the whole image build.
RUN curl -fsSL --retry 3 --retry-all-errors "https://dl.google.com/go/go${GO_VERSION}.linux-amd64.tar.gz" \
     | tar -C /usr/local -xzf - \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
  && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz" \
     | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/golangci-lint' \
  && chmod +x /usr/local/bin/golangci-lint \
  && GOPATH=/tmp/gobuild GOBIN=/usr/local/bin GOFLAGS=-mod=mod \
     go install "github.com/air-verse/air@${AIR_VERSION}" \
  && rm -rf /tmp/gobuild

# Workload CLIs. Version-pinned copies of the installs proven in
# tools/coder/image/workspace.Dockerfile:
#   op     — renders .env files from 1Password (the beta line is what ships `op environment`)
#   stripe — local webhook signing secret
#   mkcert — local TLS certs for the API's HTTP/2 dev server
#   gcx    — Grafana Cloud CLI, for querying the deployed stack's logs/metrics.
#            No credentials baked in: it resolves GRAFANA_SERVER/GRAFANA_TOKEN on
#            every invocation, so a session authenticates from repository secrets
#            rather than an interactive `gcx login`.
RUN curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_amd64_v${OP_VERSION}.zip" \
     -o /tmp/op.zip \
  && unzip -o /tmp/op.zip -d /usr/local/bin op \
  && chmod +x /usr/local/bin/op \
  && rm /tmp/op.zip \
  && curl -fsSL "https://github.com/stripe/stripe-cli/releases/download/v${STRIPE_CLI_VERSION}/stripe_${STRIPE_CLI_VERSION}_linux_x86_64.tar.gz" \
     | tar -C /usr/local/bin -xzf - stripe \
  && chmod +x /usr/local/bin/stripe \
  && curl -fsSL -o /usr/local/bin/mkcert \
     "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-amd64" \
  && chmod +x /usr/local/bin/mkcert \
  && curl -fsSL "https://github.com/grafana/gcx/releases/download/v${GCX_VERSION}/gcx_${GCX_VERSION}_linux_amd64.tar.gz" \
     | tar -C /usr/local/bin -xzf - gcx \
  && chmod +x /usr/local/bin/gcx \
  && curl -fsSL "https://github.com/PostHog/posthog/releases/download/posthog-cli/v${POSTHOG_CLI_VERSION}/posthog-cli-x86_64-unknown-linux-gnu.tar.gz" \
     | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/posthog-cli' \
  && chmod +x /usr/local/bin/posthog-cli

# Python runtime deps for the supervisor + bridge.
RUN pip install uv httpx websockets "pydantic>=2.0" "PyJWT[crypto]"

# Agent toolchain: OpenCode, code-server, agent-browser, ttyd.
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm install -g "@opencode-ai/plugin@${OPENCODE_VERSION}" zod \
  && curl -fsSL -o /tmp/code-server.deb \
     "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
  && dpkg -i /tmp/code-server.deb \
  && rm /tmp/code-server.deb \
  && npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
  && agent-browser install \
  && curl -fsSL -o /usr/local/bin/ttyd \
     "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
  && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
  && chmod +x /usr/local/bin/ttyd \
  && mkdir -p /workspace /app /tmp/opencode \
  # E2B runs as non-root `user`; the supervisor clones into /workspace and writes
  # /tmp/opencode, so make them world-writable (sticky).
  && chmod 1777 /workspace /tmp/opencode

# Pre-build OpenCode's plugin deps, mirroring modal-infra/src/images/base.py.
# Without this, OpenCode's Npm.install() runs an arborist reify() (2-22s) before
# the first prompt of EVERY session, prebuilt or not. Staged twice: /app for the
# per-session .opencode/ copy, and OpenCode's global config dir so the runtime's
# _seed_global_opencode_deps() finds node_modules already present and no-ops.
#
# E2B's HOME is /home/user (e2b-provider.ts), not Modal's /root, and
# opencode_server.py resolves the global config dir from Path.home(). The
# account is created by E2B after this layer, so chown numerically and treat the
# seed as best-effort — the runtime falls back to copying if E2B shadows it.
RUN mkdir -p /app/opencode-deps \
  && echo "{\"name\":\"opencode-tools\",\"type\":\"module\",\"dependencies\":{\"@opencode-ai/plugin\":\"${OPENCODE_VERSION}\"}}" \
     > /app/opencode-deps/package.json \
  && cd /app/opencode-deps \
  && npm install --ignore-scripts --no-audit --no-fund \
  && mkdir -p /home/user/.config/opencode \
  && cp -a /app/opencode-deps/. /home/user/.config/opencode/ \
  && chown -R 1000:1000 /home/user \
  && chmod -R a+rX /app/opencode-deps

RUN npm install -g "@posthog/wizard@${POSTHOG_WIZARD_VERSION}" \
  && mkdir -p /home/user/.config/opencode \
  && gcx agent skills install --all --dir /home/user/.agents \
  && posthog-cli api agents-md install --path /home/user/.config/opencode/AGENTS.md \
  && chown -R 1000:1000 /home/user \
  && chmod -R a+rX /home/user/.agents

# envd runs every sandbox process with its own PATH
# (/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games) and ignores a
# create-time PATH, so /usr/sbin is unreachable from the non-login shells that
# sandbox commands run in — the gap the Modal image closes with image ENV, which
# E2B drops. Link the handful that matters into /usr/local/bin instead. dockerd
# itself is unaffected: the boot hook starts it through sudo, whose secure_path
# already includes the sbin directories.
RUN for tool in iptables ip6tables iptables-save iptables-restore \
                useradd usermod groupadd service; do \
      ln -sf "/usr/sbin/$tool" "/usr/local/bin/$tool"; \
    done

# Shared, world-writable caches. A prebuilt repo image warms these during its
# build and the snapshot carries them into every session; they live outside
# $HOME so the build (root) and the session (`user`) address them identically.
RUN mkdir -p /opt/pnpm-store /opt/pnpm-home /opt/turbo-cache /opt/go/bin /opt/go/pkg/mod \
  && chmod -R 1777 /opt/pnpm-store /opt/pnpm-home /opt/turbo-cache /opt/go

# Put /app on Python's import path via a .pth file so `python3 -m sandbox_runtime`
# resolves without a PYTHONPATH env var. build-template.py stages sandbox_runtime
# into /app; git invokes the credential helper below as a subprocess that does not
# reliably inherit the supervisor's PYTHONPATH, so relying on the env var alone is
# fragile. This is the E2B equivalent of the pip-installed runtime on Vercel.
RUN printf '/app\n' > "$(python -c 'import site; print(site.getsitepackages()[0])')/oi-app-path.pth"

# Bake the git credential-helper shim system-wide, matching the Vercel/Daytona
# base images and the runtime's _ensure_credential_helper_configured fallback.
# E2B runs as a non-root user that cannot write /usr/local/bin at runtime, so
# the shim must exist at build time — otherwise private-repo clone/fetch/push
# get no brokered credentials. The shim execs the runtime's Python helper, which
# resolves via the /app .pth above regardless of the caller's environment.
RUN printf '%s\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' \
     > /usr/local/bin/oi-git-credentials \
  && chmod 0755 /usr/local/bin/oi-git-credentials \
  && git config --system credential.helper /usr/local/bin/oi-git-credentials \
  && git config --system credential.useHttpPath true

# Build-time env only. E2B does NOT propagate Docker ENV to the runtime process:
# everything the supervisor needs (HOME/PYTHONPATH/NODE_PATH, PATH, COREPACK_HOME,
# GOPATH, CONTROL_PLANE_URL, secrets, …) is injected by the control plane via
# create-time envVars — see E2B_SANDBOX_ENV in
# packages/control-plane/src/sandbox/providers/e2b-provider.ts. Anything added
# here that a session needs must be added there too.
#
# Deliberately no SANDBOX_VERSION here. It would never reach the supervisor (see
# above), so a literal could only rot: image selection gates on the version the
# runtime *reports*, which comes from E2B_SANDBOX_VERSION in the control plane —
# derived from sandbox_runtime/runtime_manifest.json. A second copy in this file
# would drift below the floor the next time the manifest bumps, with nothing to
# catch it.
ENV HOME=/root \
    NODE_ENV=development \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules

# NOTE: file staging (sandbox_runtime), WORKDIR, and the start/ready commands
# are applied by build-template.py via the E2B Template SDK
# (.copy()/.setWorkdir()/.setStartCmd()) — not here. This Dockerfile defines only
# the base image layers; it is not built standalone.
