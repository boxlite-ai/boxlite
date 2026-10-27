"""
Box.attach through the native binding, against a loopback box API (no VM).

A REST runtime resolves box1 from the stub, and every WebSocket the stub
accepts plays one session: "hi" on stdout, then exit code 7. The stub records
the target of each request, so the route and the read-only query come from
the binding, not from the test.
"""

import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite

pytestmark = pytest.mark.skipif(
    not hasattr(boxlite, "Boxlite"), reason="native Rust extension not available"
)

BOX = {
    "box_id": "box1",
    "name": None,
    "status": "running",
    "created_at": "2026-07-14T00:00:00Z",
    "updated_at": "2026-07-14T00:00:00Z",
    "pid": None,
    "image": "alpine:3.20",
    "cpus": 1,
    "memory_mib": 256,
}


def frame(opcode, payload):
    """One final, unmasked server frame; every payload here fits 7 bits."""
    return bytes([0x80 | opcode, len(payload)]) + payload


@pytest.fixture
def box_api():
    """Yields the stub's URL and the target of every request it received."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            requests.append(self.path)
            path = self.path.split("?")[0]
            if path == "/v1/boxes/box1":
                payload = json.dumps(BOX).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            elif path == "/v1/boxes/box1/attach":
                self.play_session({"X-Boxlite-Execution-Id": "init-1"})
            elif path == "/v1/boxes/box1/executions/exec-1/attach":
                self.play_session({})
            else:
                self.send_error(404)

        def play_session(self, headers):
            """Completes the upgrade by hand, then holds the socket until the
            client hangs up, which it does on the exit frame."""
            key = (
                self.headers["Sec-WebSocket-Key"]
                + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            )
            accept = base64.b64encode(hashlib.sha1(key.encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(frame(0x2, b"\x01hi"))
            self.wfile.write(frame(0x1, b'{"type":"exit","exit_code":7}'))
            self.wfile.flush()
            self.connection.settimeout(10)
            try:
                while self.rfile.read(1):
                    pass
            except OSError:
                pass
            self.close_connection = True

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", requests
    server.shutdown()
    server.server_close()


class TestAttach:
    @pytest.mark.asyncio
    async def test_attach_joins_the_main_session(self, box_api):
        url, requests = box_api
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get("box1")

        execution = await box.attach()

        assert execution.id() == "init-1"
        lines = [line async for line in execution.stdout()]
        result = await execution.wait()
        assert (lines, result.exit_code) == (["hi"], 7)
        assert "/v1/boxes/box1/attach" in requests

    @pytest.mark.asyncio
    async def test_attach_rejoins_an_exec_by_id_read_only(self, box_api):
        url, requests = box_api
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get("box1")

        execution = await box.attach("exec-1", stdin=False)

        assert execution.id() == "exec-1"
        assert (await execution.wait()).exit_code == 7
        assert "/v1/boxes/box1/executions/exec-1/attach?stdin=0" in requests


class TestTheSyncFace:
    def test_sync_attach_joins_the_main_session(self, box_api):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")

        url, requests = box_api
        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            execution = runtime.get("box1").attach()
            lines = list(execution.stdout())
            result = execution.wait()

        assert (lines, result.exit_code) == (["hi"], 7)
        assert "/v1/boxes/box1/attach" in requests

    def test_sync_attach_rejoins_an_exec_by_id_read_only(self, box_api):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")

        url, requests = box_api
        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            result = runtime.get("box1").attach("exec-1", stdin=False).wait()

        assert result.exit_code == 7
        assert "/v1/boxes/box1/executions/exec-1/attach?stdin=0" in requests
