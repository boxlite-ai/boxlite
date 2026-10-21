"""S6: explicit API/runner mocks exercise the real native SDK wire contract.

No VM or memory image is created by the mocks. Production-local refusal is
tested separately below. This suite qualifies MOCK_PASS, never RAM restore.
"""

import http.client
import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

import boxlite
from boxlite.errors import (
    AlreadyExistsError,
    InvalidStateError,
    NotFoundError,
    UnsupportedError,
)

SOURCE = "01HJK4TNRPQSXYZ8WM6NCVT9R5"
CHILD = "01HJK4TNRPQSXYZ8WM6NCVT9R6"


def box_record(box_id, name):
    return {
        "box_id": box_id,
        "name": name,
        "status": "configured",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "image": "alpine:3.23",
        "cpus": 1,
        "memory_mib": 128,
        "labels": {"snapshot_mock": "true"},
    }


@contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


class JsonHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        return json.loads(
            self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}"
        )


@pytest.fixture
def memory_mock_chain():
    records, runner_calls, api_calls = {}, [], []

    class MockRunner(JsonHandler):
        def do_GET(self):
            runner_calls.append(("GET", self.path, None))
            name = self.path.rsplit("/", 1)[-1]
            if name == "snapshots":
                self.respond(200, {"snapshots": list(records.values())})
            elif name in records:
                self.respond(200, records[name])
            else:
                self.respond(
                    404, {"error": {"code": "not_found", "message": "missing snapshot"}}
                )

        def do_POST(self):
            body = self.body()
            runner_calls.append(("POST", self.path, body))
            if self.path.endswith("/boxes"):
                if self.path.split("/")[-2] not in records:
                    self.respond(
                        404,
                        {"error": {"code": "not_found", "message": "missing snapshot"}},
                    )
                else:
                    self.respond(201, box_record(CHILD, body["name"]))
                return
            assert body["snapshot_type"] == "memory"
            name = body["name"]
            if name in records:
                self.respond(
                    409,
                    {
                        "error": {
                            "code": "already_exists",
                            "message": "duplicate snapshot",
                        }
                    },
                )
                return
            record = {
                "id": "mock-" + name,
                "box_id": SOURCE,
                "name": name,
                "created_at": 1767225600,
                "snapshot_type": "memory",
                "is_mock": True,
                "container_disk_bytes": 0,
                "size_bytes": 0,
            }
            if name == "downgrade":
                record["snapshot_type"] = "filesystem"
            if name == "fake-real":
                record["is_mock"] = False
            records[name] = record
            self.respond(201, record)

        def do_DELETE(self):
            runner_calls.append(("DELETE", self.path, None))
            records.pop(self.path.rsplit("/", 1)[-1], None)
            self.respond(200, {})

    with serve(MockRunner) as runner_port:

        class MockAPI(JsonHandler):
            def dispatch(self):
                body = self.body() if self.command == "POST" else None
                api_calls.append((self.command, self.path, body))
                if self.path == "/v1/config":
                    # The test server supports simulated snapshots; it never
                    # advertises real memory capture.
                    self.respond(
                        200,
                        {
                            "capabilities": {
                                "snapshots_enabled": True,
                                "memory_snapshots_enabled": False,
                            }
                        },
                    )
                elif self.path == "/v1/boxes/" + SOURCE:
                    self.respond(200, box_record(SOURCE, "mock-source"))
                else:
                    connection = http.client.HTTPConnection(
                        "127.0.0.1", runner_port, timeout=5
                    )
                    connection.request(
                        self.command,
                        self.path,
                        body=None if body is None else json.dumps(body),
                        headers={"Content-Type": "application/json"},
                    )
                    response = connection.getresponse()
                    payload = json.load(response)
                    connection.close()
                    self.respond(response.status, payload)

            do_GET = do_POST = do_DELETE = dispatch

        with serve(MockAPI) as api_port:
            yield f"http://127.0.0.1:{api_port}", runner_calls, api_calls


@pytest.mark.asyncio
async def test_memory_snapshot_mock_lifecycle(memory_mock_chain):
    url, runner_calls, api_calls = memory_mock_chain
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    source = await runtime.get(SOURCE)
    snapshot = await source.snapshot.create(
        name="checkpoint", options=boxlite.SnapshotOptions("memory")
    )
    assert snapshot.snapshot_type == "memory" and snapshot.is_mock
    assert snapshot.size_bytes == 0
    queried = await source.snapshot.get("checkpoint")
    assert queried.id == snapshot.id and queried.is_mock
    assert [s.id for s in await source.snapshot.list()] == [snapshot.id]
    with pytest.raises(AlreadyExistsError):
        await source.snapshot.create(
            name="checkpoint", options=boxlite.SnapshotOptions("memory")
        )
    child = await source.snapshot.create_box("checkpoint", name="mock-child")
    assert child.id == CHILD and child.id != source.id
    assert (
        "POST",
        f"/v1/boxes/{SOURCE}/snapshots/checkpoint/boxes",
        {"name": "mock-child"},
    ) in runner_calls
    assert (
        "POST",
        f"/v1/boxes/{SOURCE}/snapshots",
        {"name": "checkpoint", "snapshot_type": "memory"},
    ) in runner_calls
    await source.snapshot.remove("checkpoint")
    assert await source.snapshot.get("checkpoint") is None
    with pytest.raises(NotFoundError):
        await source.snapshot.create_box("checkpoint", name="missing-child")
    assert all(call in api_calls for call in runner_calls)


@pytest.mark.asyncio
async def test_memory_snapshot_mock_cannot_downgrade_or_claim_real(memory_mock_chain):
    url, _, _ = memory_mock_chain
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    source = await runtime.get(SOURCE)
    with pytest.raises(InvalidStateError, match="different snapshot type"):
        await source.snapshot.create(
            name="downgrade", options=boxlite.SnapshotOptions("memory")
        )
    with pytest.raises(UnsupportedError, match="real memory"):
        await source.snapshot.create(
            name="fake-real", options=boxlite.SnapshotOptions("memory")
        )


@pytest.mark.asyncio
async def test_memory_snapshot_production_local_is_unsupported(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    source = await runtime.create(
        boxlite.BoxOptions(image="alpine:3.23", auto_remove=False)
    )
    try:
        with pytest.raises(UnsupportedError, match="memory"):
            await source.snapshot.create(
                name="checkpoint", options=boxlite.SnapshotOptions("memory")
            )
        assert await source.snapshot.list() == []
        with pytest.raises(NotFoundError):
            await source.snapshot.create_box("checkpoint", name="child")
        assert len(await runtime.list_info()) == 1
    finally:
        await runtime.remove(source.id, force=True)


def test_memory_snapshot_type_validation():
    assert boxlite.SnapshotOptions().snapshot_type == "filesystem"
    with pytest.raises(ValueError):
        boxlite.SnapshotOptions("ram-pretend")
