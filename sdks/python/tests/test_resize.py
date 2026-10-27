"""Exercise resize through the native binding and REST transport."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite

pytestmark = pytest.mark.skipif(
    not hasattr(boxlite, "BoxResources"), reason="native extension not built"
)


@pytest.fixture
def resize_server():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(
                200,
                {
                    "box_id": "box1",
                    "status": "running",
                    "image": "alpine",
                    "created_at": "2026-07-14T00:00:00Z",
                    "updated_at": "2026-07-14T00:00:00Z",
                    "cpus": 1,
                    "memory_mib": 256,
                },
            )

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            if body.get("cpus") == 1:
                self.reply(
                    400,
                    {
                        "error": {
                            "message": "cannot shrink",
                            "type": "InvalidArgumentError",
                            "code": "invalid_argument",
                        }
                    },
                )
                return
            self.reply(
                200,
                {"cpus": 2, "memory_mib": 512, "max_cpus": 8, "max_memory_mib": 4096},
            )

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", requests
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.mark.asyncio
async def test_resize_crosses_native_binding(resize_server):
    url, requests = resize_server
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    box = await runtime.get("box1")
    result = await box.resize(cpus=2, memory_mib=512)
    assert isinstance(result, boxlite.BoxResources)
    assert (result.cpus, result.memory_mib, result.max_cpus, result.max_memory_mib) == (
        2,
        512,
        8,
        4096,
    )
    assert requests == [("/v1/boxes/box1/resize", {"cpus": 2, "memory_mib": 512})]
    with pytest.raises(boxlite.InvalidArgumentError, match="cannot shrink"):
        await box.resize(cpus=1)


def test_sync_resize_uses_native_binding(resize_server):
    pytest.importorskip("greenlet")
    url, requests = resize_server
    with boxlite.SyncBoxlite.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
        result = runtime.get("box1").resize(memory_mib=512)
        assert result.memory_mib == 512
    assert requests[0] == ("/v1/boxes/box1/resize", {"memory_mib": 512})
