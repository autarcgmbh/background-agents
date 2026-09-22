#!/usr/bin/env bash
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
mkdir -p /opt/openinspect/node /opt/openinspect/uv
download_dir="$(mktemp -d /tmp/openinspect-languages.XXXXXX)"
trap 'rm -rf "$download_dir"' EXIT
download_checked "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$download_dir/node.tar.xz"
tar -xJf "$download_dir/node.tar.xz" -C /opt/openinspect/node --strip-components=1
download_checked "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" "$UV_SHA256" "$download_dir/uv.tar.gz"
tar -xzf "$download_dir/uv.tar.gz" -C /opt/openinspect/uv --strip-components=1
export UV_PYTHON_INSTALL_DIR=/opt/openinspect/python-downloads
# Expose Python through the infrastructure venv below, not uv's ~/.local/bin
# symlink. If a repo prepends that directory (e.g. after installing AWS CLI),
# CPython's venv records the shim directory as home and cannot locate encodings.
/opt/openinspect/uv/uv python install --no-bin "$PYTHON_VERSION"
/opt/openinspect/uv/uv venv --python "$PYTHON_VERSION" /opt/openinspect/python
for command in node npm npx; do ln -sf "/opt/openinspect/node/bin/$command" "/usr/local/bin/$command"; done
for command in uv uvx; do ln -sf "/opt/openinspect/uv/$command" "/usr/local/bin/$command"; done
for command in python python3; do ln -sf /opt/openinspect/python/bin/python "/usr/local/bin/$command"; done
