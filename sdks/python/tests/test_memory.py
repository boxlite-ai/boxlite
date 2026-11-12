"""Integer MiB allocations through the native Python binding and REST client."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension module not built",
)


@pytest.mark.asyncio
async def test_memory_requests_preserve_mib_and_reject_invalid_values():
    import boxlite

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            payload = json.dumps(
                {
                    "box_id": "memory",
                    "status": "configured",
                    "image": "alpine",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "cpus": 1,
                    "memory_mib": body.get("memory_mib", 1024),
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        runtime = boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(url=f"http://127.0.0.1:{server.server_port}")
        )
        for mib in [None, 256, 257, 513, 768, 1536, 4294967295]:
            await runtime.create(boxlite.BoxOptions("alpine", memory_mib=mib))
            path, body = requests[-1]
            assert path == "/v1/boxes"
            if mib is None:
                assert "memory_mib" not in body
            else:
                assert body["memory_mib"] == mib
        count = len(requests)
        for mib in [0, -1, 255, 256.5, float("nan"), float("inf"), 4294967296]:
            with pytest.raises(
                (ValueError, TypeError, OverflowError, boxlite.BoxliteError)
            ):
                await runtime.create(boxlite.BoxOptions("alpine", memory_mib=mib))
        assert len(requests) == count
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
