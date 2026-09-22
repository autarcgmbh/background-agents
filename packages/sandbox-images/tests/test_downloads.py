"""Exercise the install helper with real curl and a fault-injecting HTTP server."""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

COMMON_SH = Path(__file__).resolve().parents[1] / "install/common.sh"


@pytest.fixture
def download_server():
    replies = []
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            status, body, truncate = replies.pop(0)
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[: len(body) // 2] if truncate else body)
            self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/archive", replies, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_recovers_from_504_and_truncated_transfer_before_extracting(tmp_path, download_server):
    url, replies, requests = download_server
    payload = b"complete executable contents\n"
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        entry = tarfile.TarInfo("tool")
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
    contents = buffer.getvalue()
    replies.extend(
        [(504, b"gateway timeout", False), (200, contents, True), (200, contents, False)]
    )
    destination = tmp_path / "tool.tar.gz"
    subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; download_file "$2" "$3"; tar -xzf "$3" -C "$4"',
            "test-download",
            str(COMMON_SH),
            url,
            str(destination),
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    assert len(requests) == 3
    assert destination.read_bytes() == contents
    assert (tmp_path / "tool").read_bytes() == payload


def test_exhausted_retries_stop_the_installation(tmp_path, download_server):
    url, replies, requests = download_server
    replies.extend([(504, b"gateway timeout", False)] * 4)
    marker = tmp_path / "extraction-started"
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; download_file "$2" "$3"; touch "$4"',
            "test-download",
            str(COMMON_SH),
            url,
            str(tmp_path / "archive.tar.gz"),
            str(marker),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    assert len(requests) == 4
    assert not marker.exists()
    assert f"Download failed after retries: {url} (curl exit 22)" in result.stderr


@pytest.mark.parametrize("valid_checksum", [True, False])
def test_checked_download_still_enforces_checksum(tmp_path, download_server, valid_checksum):
    url, replies, _ = download_server
    contents = b"downloaded binary"
    replies.append((200, contents, False))
    digest = hashlib.sha256(contents).hexdigest() if valid_checksum else "0" * 64
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; download_checked "$2" "$3" "$4"',
            "test-download",
            str(COMMON_SH),
            url,
            digest,
            str(tmp_path / "binary"),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert (result.returncode == 0) == valid_checksum


@pytest.mark.parametrize("asset_exists", [True, False])
def test_github_fallback_uses_exact_tag_asset_and_checksum(tmp_path, download_server, asset_exists):
    url, replies, requests = download_server
    contents = b"pinned release binary"
    asset_url = "https://api.github.com/repos/grafana/agento11y/releases/assets/123"
    metadata = {"assets": [{"name": "agento11y.tar.gz", "url": asset_url}] if asset_exists else []}
    replies.extend([(504, b"gateway timeout", False)] * 4)
    replies.append((200, json.dumps(metadata).encode(), False))
    if asset_exists:
        replies.append((200, contents, False))

    # Route the helper's real HTTP requests to the fault-injecting server while
    # preserving GitHub host/path matching in the shell code under test.
    wrapper = tmp_path / "curl"
    wrapper.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\n"
        f"origin = {url.removesuffix('/archive')!r}\n"
        "args = [arg.replace('https://github.com', origin + '/github')"
        ".replace('https://api.github.com', origin + '/api') for arg in sys.argv[1:]]\n"
        f"os.execv({shutil.which('curl')!r}, ['curl', *args])\n"
    )
    wrapper.chmod(0o755)
    destination = tmp_path / "binary"
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; download_checked "$2" "$3" "$4"',
            "test-download",
            str(COMMON_SH),
            "https://github.com/grafana/agento11y/releases/download/plugins/agento11y/v0.48.0/agento11y.tar.gz",
            hashlib.sha256(contents).hexdigest(),
            str(destination),
        ],
        env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert (result.returncode == 0) == asset_exists
    assert requests[4] == "/api/repos/grafana/agento11y/releases/tags/plugins%2Fagento11y%2Fv0.48.0"
    if asset_exists:
        assert requests[5] == "/api/repos/grafana/agento11y/releases/assets/123"
        assert destination.read_bytes() == contents
    else:
        assert len(requests) == 5
        assert "Download failed after retries:" in result.stderr
