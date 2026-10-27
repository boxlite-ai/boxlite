"""Snapshot contracts across the native extension and a real HTTP boundary."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite


@pytest.fixture
def server():
    """A box API stub answering each (method, path) with a fixed reply.

    Yields its URL, the replies to fill in, and every (method, path, body) it
    received. A route with no reply answers 404.
    """
    replies: dict = {}
    requests: list = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            requests.append((self.command, self.path, body))
            status, reply = replies.get(
                (self.command, self.path), (404, {"message": "no route"})
            )
            payload = b"" if reply is None else json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{http.server_address[1]}", replies, requests
    http.shutdown()
    http.server_close()


SNAP = {
    "id": "snap-1",
    "box_id": "source",
    "name": "cozy-otter",
    "created_at": 1,
    "container_disk_bytes": 1024,
    "size_bytes": 256,
    "status": "ready",
}


def box_reply(identity, status):
    return {
        "box_id": identity,
        "name": "generated-child",
        "status": status,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "image": "base",
        "cpus": 2,
        "memory_mib": 512,
    }


def configure(replies):
    replies.update(
        {
            ("GET", "/v1/config"): (
                200,
                {
                    "capabilities": {
                        "snapshots_enabled": True,
                        "create_from_snapshot_enabled": True,
                    }
                },
            ),
            ("GET", "/v1/boxes/source"): (200, box_reply("source", "stopped")),
            ("POST", "/v1/boxes/source/snapshots"): (
                201,
                {**SNAP, "status": "creating"},
            ),
            ("GET", "/v1/boxes/source/snapshots/cozy-otter"): (200, SNAP),
            ("GET", "/v1/boxes/source/snapshots"): (200, {"snapshots": [SNAP]}),
            ("GET", "/v1/snapshots"): (200, {"snapshots": [SNAP]}),
            ("GET", "/v1/snapshots/snap-1"): (200, SNAP),
            ("POST", "/v1/snapshots/snap-1/boxes"): (
                201,
                box_reply("child", "configured"),
            ),
            ("GET", "/v1/boxes/child"): (200, box_reply("child", "running")),
            ("POST", "/v1/boxes/source/snapshots/snap-1/restore"): (
                202,
                {"id": "restore-1", "status": "pending"},
            ),
            ("GET", "/v1/boxes/source/restores/restore-1"): (
                200,
                {"id": "restore-1", "status": "succeeded"},
            ),
            ("DELETE", "/v1/snapshots/protected"): (403, {"message": "denied"}),
            ("DELETE", "/v1/snapshots/snap-1"): (204, None),
        }
    )


@pytest.mark.asyncio
async def test_snapshot_async_scopes_and_creation(server):
    url, replies, requests = server
    configure(replies)
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    try:
        source = await runtime.get("source")
        snap = await source.snapshot.create()
        assert (snap.id, snap.name, snap.status, snap.error) == (
            "snap-1",
            "cozy-otter",
            "ready",
            None,
        )
        replies[("POST", "/v1/boxes/source/snapshots")] = (
            201,
            {**SNAP, "name": "explicit"},
        )
        named = await source.snapshot.create(name="explicit")
        assert named.name == "explicit"
        capture_bodies = [
            json.loads(body)
            for method, path, body in requests
            if method == "POST" and path == "/v1/boxes/source/snapshots"
        ]
        assert capture_bodies == [{"name": ""}, {"name": "explicit"}]
        assert len(await source.snapshot.list()) == 1
        assert await source.snapshot.get("missing") is None
        assert (await runtime.snapshots.get(snap.id)).size_bytes == 256
        assert (await runtime.snapshots.list())[0].box_id == "source"
        with pytest.raises(boxlite.NotFoundError):
            await runtime.snapshots.get("missing")
        child = await runtime.create_from_snapshot(
            snap.id, options=boxlite.BoxOptions(cpus=2)
        )
        assert child.id == "child"
        await source.snapshot.restore(snap.id)
        await runtime.snapshots.remove("missing", force=True)
        with pytest.raises(boxlite.BoxliteError):
            await runtime.snapshots.remove("protected", force=True)
        await runtime.snapshots.remove(snap.id)
        create_requests = [
            json.loads(body)
            for method, path, body in requests
            if method == "POST" and path == "/v1/snapshots/snap-1/boxes"
        ]
        assert len(create_requests) == 1
        assert create_requests[0]["options"]["cpus"] == 2
        assert "image" not in create_requests[0]["options"]
        with pytest.raises(boxlite.InvalidArgumentError):
            await runtime.create_from_snapshot(
                snap.id, options=boxlite.BoxOptions(image="alpine:latest")
            )
    finally:
        await runtime.shutdown()


def test_snapshot_sync_wrappers_and_runtime_lifetime(server):
    url, replies, _ = server
    configure(replies)
    with boxlite.SyncBoxlite.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
        source = runtime.get("source")
        snapshots = runtime.snapshots
        snap = source.snapshot.create()
        assert snapshots.get(snap.id).status == "ready"
        assert len(snapshots.list()) == 1
        assert source.snapshot.get("missing") is None
        assert runtime.create_from_snapshot(snap.id).id == "child"
        source.snapshot.restore(snap.id)
        snapshots.remove(snap.id)
    with pytest.raises(RuntimeError):
        snapshots.list()
