"""Checkpoint contracts through the real native binding and HTTP transport."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite

if importlib.util.find_spec("boxlite.boxlite") is None:
    pytest.skip("native extension module not built", allow_module_level=True)
from boxlite.boxlite import (  # noqa: F401 - validate native exports
    CheckpointDependencies,
    CheckpointHandle,
    CheckpointInfo,
    RuntimeCheckpointHandle,
)

from boxlite import boxlite as native

PREFIX = "/base/v1/team"
SAVED = {
    "id": "checkpoint-1",
    "box_id": "source",
    "name": "before-upgrade",
    "status": "ready",
    "error": None,
    "created_at": 1,
    "cpus": 2,
    "memory_bytes": 4096,
    "container_disk_bytes": 8192,
    "size_bytes": 16384,
}


def box_reply(identity, status):
    return {
        "box_id": identity,
        "name": identity,
        "status": status,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "image": "base",
        "cpus": 2,
        "memory_mib": 512,
    }


@pytest.fixture
def checkpoint_server():
    replies = {
        ("GET", "/base/v1/config"): (
            200,
            {
                "capabilities": {
                    "checkpoints_enabled": True,
                    "checkpoint_management_enabled": True,
                }
            },
        ),
        ("GET", f"{PREFIX}/boxes/source"): (200, box_reply("source", "paused")),
        ("POST", f"{PREFIX}/boxes/source/pause"): (204, None),
        ("POST", f"{PREFIX}/boxes/source/resume"): (204, None),
        ("POST", f"{PREFIX}/boxes/source/checkpoints"): (
            201,
            {**SAVED, "status": "creating"},
        ),
        ("GET", f"{PREFIX}/boxes/source/checkpoints/checkpoint-1"): (200, SAVED),
        ("GET", f"{PREFIX}/boxes/source/checkpoints"): (200, {"checkpoints": [SAVED]}),
        ("GET", f"{PREFIX}/checkpoints"): (200, {"checkpoints": [SAVED]}),
        ("GET", f"{PREFIX}/checkpoints/checkpoint-1"): (200, SAVED),
        ("POST", f"{PREFIX}/checkpoints/checkpoint-1/boxes"): (
            201,
            box_reply("child", "restoring"),
        ),
        ("GET", f"{PREFIX}/boxes/child"): (200, box_reply("child", "paused")),
        ("DELETE", f"{PREFIX}/checkpoints/checkpoint-1"): (204, None),
        ("DELETE", f"{PREFIX}/boxes/source/checkpoints/checkpoint-1"): (204, None),
        ("DELETE", f"{PREFIX}/checkpoints/protected"): (
            403,
            {
                "error": {
                    "message": "denied",
                    "code": "permission_denied",
                    "error_type": "PermissionDeniedError",
                }
            },
        ),
        ("POST", f"{PREFIX}/boxes/source/checkpoint/export"): (
            200,
            b"invalid checkpoint bytes",
        ),
    }
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)
            requests.append(
                (self.command, self.path, body, self.headers.get("Authorization"))
            )
            status, reply = replies.get(
                (self.command, self.path),
                (
                    404,
                    {
                        "error": {
                            "message": "missing",
                            "code": "not_found",
                            "error_type": "NotFoundError",
                        }
                    },
                ),
            )
            payload = (
                reply
                if isinstance(reply, bytes)
                else b""
                if reply is None
                else json.dumps(reply).encode()
            )
            self.send_response(status)
            self.send_header(
                "Content-Type",
                "application/octet-stream"
                if isinstance(reply, bytes)
                else "application/json",
            )
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    options = boxlite.BoxliteRestOptions(
        url=f"http://127.0.0.1:{server.server_address[1]}/base",
        path_prefix="team",
        credential=boxlite.ApiKeyCredential("checkpoint-test"),
    )
    yield options, replies, requests
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.mark.asyncio
async def test_checkpoint_async_catalog_lifecycle_and_requests(checkpoint_server):
    options, replies, requests = checkpoint_server
    runtime = boxlite.Boxlite.rest(options)
    try:
        source = await runtime.get("source")
        await source.pause()
        await source.pause(host_writers_stopped=False)
        await source.pause(host_writers_stopped=True)
        await source.resume()
        saved = await source.checkpoint.create()
        assert isinstance(saved, boxlite.CheckpointInfo)
        assert (
            saved.id,
            saved.status,
            saved.box_id,
            saved.cpus,
            saved.memory_bytes,
            saved.size_bytes,
            saved.error,
        ) == ("checkpoint-1", "ready", "source", 2, 4096, 16384, None)
        replies[("POST", f"{PREFIX}/boxes/source/checkpoints")] = (201, SAVED)
        await source.checkpoint.create(name=None)
        await source.checkpoint.create(name="before-upgrade")
        assert len(await source.checkpoint.list()) == 1
        assert await source.checkpoint.get("missing") is None
        catalog = runtime.checkpoints()
        assert len(await catalog.list()) == 1
        assert (await catalog.get(saved.id)).name == saved.name
        with pytest.raises(boxlite.NotFoundError):
            await catalog.get("missing")
        await runtime.create_from_checkpoint(saved.id)
        for name in (None, "restored-child"):
            child = await runtime.create_from_checkpoint(saved.id, name=name)
            assert (child.id, (await child.info()).state.status) == ("child", "paused")
        await source.checkpoint.remove(saved.id)
        await catalog.remove("missing", force=True)
        with pytest.raises(boxlite.BoxliteError):
            await catalog.remove("protected", force=True)
        await catalog.remove(saved.id)
        captures = [
            json.loads(body)
            for method, path, body, _ in requests
            if method == "POST" and path.endswith("/source/checkpoints")
        ]
        restores = [
            json.loads(body)
            for method, path, body, _ in requests
            if method == "POST" and path.endswith("/checkpoint-1/boxes")
        ]
        pauses = [
            json.loads(body)
            for method, path, body, _ in requests
            if method == "POST" and path.endswith("/pause")
        ]
        assert captures == [{}, {}, {"name": "before-upgrade"}]
        assert restores == [{}, {}, {"name": "restored-child"}]
        assert pauses == [
            {"host_writers_stopped": False},
            {"host_writers_stopped": False},
            {"host_writers_stopped": True},
        ]
        assert all(auth == "Bearer checkpoint-test" for _, _, _, auth in requests)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_checkpoint_rejects_running_restore_and_missing_capability(
    checkpoint_server,
):
    options, replies, requests = checkpoint_server
    replies[("POST", f"{PREFIX}/checkpoints/checkpoint-1/boxes")] = (
        201,
        box_reply("child", "running"),
    )
    runtime = boxlite.Boxlite.rest(options)
    try:
        with pytest.raises(boxlite.InvalidStateError, match="child"):
            await runtime.create_from_checkpoint("checkpoint-1")
        assert sum(method == "POST" for method, _, _, _ in requests) == 1
    finally:
        await runtime.shutdown()
    requests.clear()
    replies[("GET", "/base/v1/config")] = (200, {"capabilities": {}})
    runtime = boxlite.Boxlite.rest(options)
    try:
        with pytest.raises(boxlite.UnsupportedError):
            await runtime.checkpoints().list()
        with pytest.raises(boxlite.UnsupportedError):
            await runtime.import_checkpoint("caller-only", name="new-box")
        assert not any(method == "POST" for method, _, _, _ in requests)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_checkpoint_pair_paths_are_caller_local(checkpoint_server, tmp_path):
    options, _, requests = checkpoint_server
    runtime = boxlite.Boxlite.rest(options)
    try:
        source = await runtime.get("source")
        missing = tmp_path / "caller-only"
        with pytest.raises(boxlite.StorageError):
            await runtime.import_checkpoint(missing, name="restored")
        with pytest.raises(boxlite.StorageError):
            boxlite.Boxlite.inspect_checkpoint(missing)
        assert not any("/checkpoint/import" in path for _, path, _, _ in requests)
        destination = tmp_path / "exported"
        with pytest.raises(boxlite.StorageError):
            await source.export_checkpoint(destination)
        assert not destination.exists()
        assert [path for method, path, _, _ in requests if method == "POST"] == [
            f"{PREFIX}/boxes/source/checkpoint/export"
        ]
        assert all(str(tmp_path).encode() not in body for _, _, body, _ in requests)
    finally:
        await runtime.shutdown()


def test_checkpoint_sync_uses_native_catalog_and_enforces_lifetime(checkpoint_server):
    pytest.importorskip("greenlet")
    options, _, requests = checkpoint_server
    with boxlite.SyncBoxlite.rest(options) as runtime:
        source = runtime.get("source")
        catalog = runtime.checkpoints()
        scoped = source.checkpoint
        source.pause()
        source.resume()
        saved = scoped.create(name="before-upgrade")
        assert catalog.get(saved.id).status == "ready"
        assert len(scoped.list()) == len(catalog.list()) == 1
        assert scoped.get("missing") is None
        assert runtime.create_from_checkpoint(saved.id).id == "child"
        scoped.remove("missing", force=True)
        catalog.remove(saved.id)
    with pytest.raises(RuntimeError, match="not started"):
        catalog.list()
    with pytest.raises(RuntimeError, match="not started"):
        scoped.create()
    with pytest.raises(RuntimeError, match="not started"):
        source.pause()
    assert any(path.endswith("/pause") for _, path, _, _ in requests)


@pytest.mark.asyncio
async def test_checkpoint_python_keeps_full_integer_metadata(checkpoint_server):
    options, replies, _ = checkpoint_server
    replies[("GET", f"{PREFIX}/checkpoints/checkpoint-1")] = (
        200,
        {
            **SAVED,
            "created_at": -(2**63),
            "memory_bytes": 2**64 - 1,
            "container_disk_bytes": 2**64 - 2,
            "size_bytes": 2**64 - 3,
        },
    )
    runtime = boxlite.Boxlite.rest(options)
    try:
        info = await runtime.checkpoints().get("checkpoint-1")
        assert (
            info.created_at,
            info.memory_bytes,
            info.container_disk_bytes,
            info.size_bytes,
        ) == (-(2**63), 2**64 - 1, 2**64 - 2, 2**64 - 3)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_checkpoint_failed_capture_preserves_error_without_resubmission(
    checkpoint_server,
):
    options, replies, requests = checkpoint_server
    replies[("GET", f"{PREFIX}/boxes/source/checkpoints/checkpoint-1")] = (
        200,
        {**SAVED, "status": "failed", "error": "capture storage failed"},
    )
    runtime = boxlite.Boxlite.rest(options)
    try:
        source = await runtime.get("source")
        with pytest.raises(
            boxlite.InvalidStateError, match="checkpoint-1.*capture storage failed"
        ):
            await source.checkpoint.create()
        assert sum(method == "POST" for method, _, _, _ in requests) == 1
    finally:
        await runtime.shutdown()


def test_checkpoint_native_exports():
    for name in (
        "CheckpointInfo",
        "CheckpointDependencies",
        "CheckpointHandle",
        "RuntimeCheckpointHandle",
    ):
        assert getattr(boxlite, name) is getattr(native, name)
