"""Exercise public Box.export over loopback REST without starting a VM."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension not built",
)

BOX_ID = "source-box"
BOX_PATH = f"/v1/boxes/{BOX_ID}"
EXPORT_PATH = f"{BOX_PATH}/export"
ARCHIVE_BYTES = b"\x00\xffB"


@pytest.fixture
def export_server():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.command, self.path, b""))
            if self.path == BOX_PATH:
                self.reply_json(
                    {
                        "box_id": BOX_ID,
                        "name": None,
                        "status": "stopped",
                        "created_at": "2026-08-07T00:00:00Z",
                        "updated_at": "2026-08-07T00:00:00Z",
                        "pid": None,
                        "image": "alpine:latest",
                        "cpus": 1,
                        "memory_mib": 256,
                    }
                )
            elif self.path == "/v1/config":
                self.reply_json({"capabilities": {"export_enabled": True}})
            else:
                self.send_error(404)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append((self.command, self.path, body))
            if self.path == EXPORT_PATH:
                self.reply("application/octet-stream", ARCHIVE_BYTES)
            else:
                self.send_error(404)

        def reply_json(self, data):
            self.reply("application/json", json.dumps(data).encode())

        def reply(self, content_type, body):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requests
        finally:
            server.shutdown()
            thread.join()


@pytest.mark.asyncio
@pytest.mark.parametrize("include_memory", [True, False], ids=["full", "disk-only"])
async def test_export_rest(export_server, tmp_path, include_memory):
    url, requests = export_server
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
    try:
        box = await runtime.get(BOX_ID)
        assert box is not None
        dest = tmp_path / "backup.boxlite"
        if include_memory:
            with pytest.raises(boxlite.UnsupportedError):
                await box.export(
                    dest=str(dest), options=boxlite.ExportOptions(include_memory=True)
                )
            assert requests == [("GET", BOX_PATH, b"")]
            assert not dest.exists()
        else:
            assert await box.export(dest=str(dest)) == str(dest)
            assert requests == [
                ("GET", BOX_PATH, b""),
                ("GET", "/v1/config", b""),
                ("POST", EXPORT_PATH, b"{}"),
            ]
            assert dest.read_bytes() == ARCHIVE_BYTES
    finally:
        runtime.close()
