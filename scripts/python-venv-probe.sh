#!/usr/bin/env bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
mkdir -p /opt/openinspect/uv
curl -fsSL https://github.com/astral-sh/uv/releases/download/0.9.7/uv-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /opt/openinspect/uv --strip-components=1
export UV_PYTHON_INSTALL_DIR=/opt/openinspect/python-downloads
/opt/openinspect/uv/uv python install 3.12.12
/opt/openinspect/uv/uv venv --python 3.12.12 /opt/openinspect/python
export PATH="/opt/openinspect/python/bin:/opt/openinspect/uv:$PATH"
for command in python python3; do ln -sf /opt/openinspect/python/bin/python "/usr/local/bin/$command"; done
python3.12 -c 'import sys; print("executable:",sys.executable,"base:",sys._base_executable)'
set +e
python3.12 -m venv /tmp/current-venv
current_result=$?
echo "CURRENT_VENV_EXIT=$current_result"
/tmp/current-venv/bin/python3.12 -m ensurepip --upgrade --default-pip
set -e
uv venv --seed --python 3.12 /tmp/fixed-venv
/tmp/fixed-venv/bin/python -m pip --version
/tmp/fixed-venv/bin/python -m pip install --quiet pyproj
/tmp/fixed-venv/bin/python -c 'import pyproj; print("PROJECTION_RESULT",pyproj.Transformer.from_crs(4326,3857,always_xy=True).transform(13.4,52.5))'
/tmp/fixed-venv/bin/python -m pyproj sync --file uk_os_OSTN15_NTv2_OSGBtoETRS.tif
printf 'FIXED_VENV_VALIDATED\n'
