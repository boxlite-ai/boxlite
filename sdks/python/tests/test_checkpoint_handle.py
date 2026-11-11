"""Exercise checkpoint serialization and result ownership through native REST."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite

# Unit jobs do not build the extension; the native coverage job requires it.
# A present but unloadable extension must still fail rather than be skipped.
pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension module not built",
)

INFO = {
    "id": "checkpoint-1",
    "name": "base",
    "source_box_id": "source-1",
    "created_at": "2026-11-06T00:00:00Z",
    "size_bytes": 4096,
    "state": "ready",
}
BOX = {
    "box_id": "target-1",
    "name": "worker",
    "status": "stopped",
    "created_at": INFO["created_at"],
    "updated_at": INFO["created_at"],
    "image": "alpine:latest",
    "cpus": 2,
    "memory_mib": 512,
}


@pytest.fixture
def checkpoint_server():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def dispatch(self):
            size = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(size)) if size else None
            requests.append((self.command, self.path, body))
            if self.command == "DELETE":
                self.send_response(204)
                self.end_headers()
                return
            payload = INFO
            if self.path == "/v1/checkpoints" and self.command == "GET":
                payload = {"checkpoints": [INFO]}
            elif self.path.startswith("/v1/boxes"):
                payload = BOX
            if self.command == "GET" and self.path == "/v1/checkpoints/checkpoint-1":
                payload = {
                    **INFO,
                    "state": "failed",
                    "error_reason": "archive upload failed",
                }
            encoded = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        do_POST = do_GET = do_DELETE = dispatch

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", requests
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.mark.asyncio
async def test_checkpoint_native_rest_management_and_box_creation(checkpoint_server):
    url, requests = checkpoint_server
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    checkpoints = runtime.checkpoints
    captured = await checkpoints.create("source-1", "base")
    assert isinstance(captured, boxlite.CheckpointInfo)
    assert (captured.name, captured.size_bytes, captured.state) == (
        "base",
        4096,
        "ready",
    )
    assert (await checkpoints.list())[0].source_box_id == "source-1"
    detail = await checkpoints.get("checkpoint-1")
    assert (detail.id, detail.state, detail.error_reason) == (
        "checkpoint-1",
        "failed",
        "archive upload failed",
    )
    created = await runtime.import_box(checkpoint_id="checkpoint-1", name="worker")
    assert (created.id, created.name) == ("target-1", "worker")
    recovered = await runtime.import_box(checkpoint_id="checkpoint-1", box_id="target-1")
    assert recovered.id == "target-1"
    await checkpoints.remove("checkpoint-1", True)
    await checkpoints.remove("checkpoint-1")
    await checkpoints.remove("checkpoint-1", False)
    await checkpoints.create("source-1")
    await runtime.import_box(checkpoint_id="checkpoint-1")
    assert requests == [
        ("POST", "/v1/checkpoints", {"source_box_id": "source-1", "name": "base"}),
        ("GET", "/v1/checkpoints", None),
        ("GET", "/v1/checkpoints/checkpoint-1", None),
        (
            "POST",
            "/v1/boxes/import",
            {"checkpoint_id": "checkpoint-1", "name": "worker"},
        ),
        (
            "POST",
            "/v1/boxes/import",
            {"checkpoint_id": "checkpoint-1", "box_id": "target-1"},
        ),
        ("DELETE", "/v1/checkpoints/checkpoint-1?force=true", None),
        ("DELETE", "/v1/checkpoints/checkpoint-1", None),
        ("DELETE", "/v1/checkpoints/checkpoint-1", None),
        ("POST", "/v1/checkpoints", {"source_box_id": "source-1"}),
        ("POST", "/v1/boxes/import", {"checkpoint_id": "checkpoint-1"}),
    ]


def test_checkpoint_sync_bridge_returns_managed_box_handles(checkpoint_server):
    url, requests = checkpoint_server
    with boxlite.SyncBoxlite.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
        assert runtime.checkpoints.list()[0].id == "checkpoint-1"
        target = runtime.import_box(checkpoint_id="checkpoint-1", name="worker")
        assert isinstance(target, boxlite.SyncBox)
        assert target.id == "target-1"
        assert (
            runtime.import_box(checkpoint_id="checkpoint-1", box_id=target.id).id
            == target.id
        )
    assert requests[1][2] == {"checkpoint_id": "checkpoint-1", "name": "worker"}
