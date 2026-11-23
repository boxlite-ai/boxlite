"""Guarded creation crosses async and sync SDK entry points."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import boxlite
from boxlite.errors import ManagedCreateError
from boxlite.sync_api import SyncBoxlite

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension not built",
)


@pytest.fixture
def managed_cloud():
    writes = []

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != "/v1/config":
                self.reply(404, {})
                return
            self.reply(200, {"capabilities": {"outbound_proxy_registry_enabled": True}})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            writes.append((self.path, body["network"]["outbound"]["proxy"]))
            self.reply(
                408, {"code": "outbound_create_admitted", "boxId": "existing-box"}
            )

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield (
                boxlite.BoxliteRestOptions(
                    url=f"http://127.0.0.1:{server.server_port}"
                ),
                writes,
            )
        finally:
            server.shutdown()
            worker.join()


@pytest.mark.asyncio
async def test_managed_proxy_async_create_keeps_admitted_box(managed_cloud):
    rest, writes = managed_cloud
    runtime = boxlite.Boxlite.rest(rest)
    try:
        with pytest.raises(ManagedCreateError) as failed:
            await runtime.create_with_outbound_proxy(
                boxlite.BoxOptions(image="alpine"), "outbound"
            )
        assert (
            failed.value.admission,
            failed.value.http_status,
            failed.value.box_id,
        ) == ("admitted", 408, "existing-box")
        assert writes == [("/v1/boxes", "outbound")]
    finally:
        runtime.close()


def test_managed_proxy_sync_create_preserves_explicit_null(managed_cloud):
    rest, writes = managed_cloud
    with SyncBoxlite.rest(rest) as runtime, pytest.raises(ManagedCreateError) as failed:
        runtime.create_with_outbound_proxy(boxlite.BoxOptions(image="alpine"), None)
    assert failed.value.box_id == "existing-box"
    assert writes == [("/v1/boxes", None)]
