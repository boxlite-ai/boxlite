"""Exercise native credential conversion and Python wrappers."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import boxlite
from boxlite.simplebox import SimpleBox
from boxlite.sync_api._ssh import SyncSshHandle


def test_ssh_native_credentials_are_redacted():
    ca = boxlite.SshCaConfig("sentinel-ca", "principal")
    account = boxlite.SshAccount("alice", ["sentinel-public"], ca)
    config = boxlite.SshConfig("0.0.0.0:2222", "sentinel-private", [account])
    assert config.accounts[0].ca.public_key == "sentinel-ca"
    assert "sentinel" not in repr(config)
    assert "sentinel" not in repr(account)
    assert "sentinel" not in repr(ca)


@pytest.mark.asyncio
async def test_ssh_simplebox_requires_initialization_and_forwards():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False
    ssh = box.ssh
    with pytest.raises(RuntimeError, match="not started"):
        await ssh.status()
    native = SimpleNamespace(
        configure=AsyncMock(return_value=1),
        status=AsyncMock(return_value=2),
        disable=AsyncMock(return_value=3),
    )
    box._box = SimpleNamespace(ssh=native)
    box._started = True
    assert await ssh.configure("config") == 1
    assert await ssh.status() == 2
    assert await ssh.disable() == 3
    native.configure.assert_awaited_once_with("config")


def test_ssh_sync_wrapper_forwards():
    owner = SimpleNamespace(_sync=asyncio.run)
    native = SimpleNamespace(
        configure=AsyncMock(return_value=1),
        status=AsyncMock(return_value=2),
        disable=AsyncMock(return_value=3),
    )
    ssh = SyncSshHandle(owner, native)
    assert ssh.configure("config") == 1
    assert ssh.status() == 2
    assert ssh.disable() == 3
    native.configure.assert_awaited_once_with("config")


@pytest.mark.asyncio
async def test_ssh_native_rest_roundtrip():
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            requests.append((self.path, json.loads(body) if body else None))
            if "/ssh" in self.path:
                value = {
                    "enabled": True,
                    "generation": 2**64 - 1,
                    "listen_address": "addr",
                    "host_public_key": "key",
                    "host_key_fingerprint": "fp",
                }
            else:
                value = {
                    "box_id": "box-test",
                    "name": None,
                    "status": "running",
                    "created_at": "2026-07-14T00:00:00Z",
                    "updated_at": "2026-07-14T00:00:00Z",
                    "pid": None,
                    "image": "alpine",
                    "cpus": 1,
                    "memory_mib": 512,
                }
            encoded = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    rt = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(url=f"http://127.0.0.1:{server.server_port}")
    )
    try:
        box = await rt.get("box-test")
        config = boxlite.SshConfig(
            "addr",
            "private",
            [boxlite.SshAccount("alice", ["key"], boxlite.SshCaConfig("ca", "alice"))],
        )
        assert (await box.ssh.configure(config)).generation == 2**64 - 1
        assert (await box.ssh.status()).host_public_key == "key"
        assert (await box.ssh.disable()).generation == 2**64 - 1
        assert requests[1][1]["accounts"][0]["ca"]["public_key"] == "ca"
        assert len(requests) == 4
    finally:
        await rt.shutdown()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_ssh_local_native_lifecycle(shared_runtime, tmp_path):
    import subprocess

    for name in ("host", "user"):
        await asyncio.to_thread(
            subprocess.run,
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(tmp_path / name)],
            check=True,
            timeout=10,
        )
    box = await shared_runtime.create(
        boxlite.BoxOptions(image="alpine:3.19", auto_remove=False)
    )
    try:
        config = boxlite.SshConfig(
            "0.0.0.0:2222",
            (tmp_path / "host").read_text(),
            [boxlite.SshAccount("alice", [(tmp_path / "user.pub").read_text()])],
        )
        assert (await box.ssh.status()).generation == 0
        assert (await box.ssh.configure(config)).enabled
        assert (await box.ssh.configure(config)).generation == 2
        assert not (await box.ssh.disable()).enabled
        await box.stop()
        box = await shared_runtime.get(box.id)
        assert (await box.ssh.status()).generation == 0
    finally:
        await shared_runtime.remove(box.id, force=True)
