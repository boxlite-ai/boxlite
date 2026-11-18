"""Secret templates cross the public Python API and the HTTP boundary."""

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


_UNSET = object()


def secret_with_headers(headers=_UNSET):
    kwargs = {"name": "bot", "value": "token", "hosts": ["api.example.com"]}
    if headers is not _UNSET:
        return boxlite.Secret(**kwargs, headers=headers)
    return boxlite.Secret(**kwargs)


@pytest.mark.asyncio
async def test_secret_headers_rest_request():
    requests = []
    metadata = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            metadata.append((self.command, self.path, self.headers.get("Content-Type")))
            requests.append(
                (
                    self.path,
                    json.loads(self.rfile.read(int(self.headers["Content-Length"]))),
                )
            )
            payload = json.dumps(
                {
                    "box_id": "secret-test",
                    "name": None,
                    "status": "configured",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "pid": None,
                    "image": "alpine:latest",
                    "cpus": 1,
                    "memory_mib": 512,
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(url=f"http://127.0.0.1:{server.server_port}")
    )
    templates = {"Authorization": "Bot {value}", "X-Key": "{value}"}
    try:
        for headers in [{"Authorization": "Bearer {value}"}, templates]:
            await runtime.create(
                boxlite.BoxOptions(
                    image="alpine:latest", secrets=[secret_with_headers(headers)]
                )
            )
        assert [path for path, _ in requests] == ["/v1/boxes"] * 2
        assert metadata == [("POST", "/v1/boxes", "application/json")] * 2
        before, after = [body for _, body in requests]
        assert before["secrets"][0].pop("headers") == {
            "Authorization": "Bearer {value}"
        }
        assert after["secrets"][0].pop("headers", None) == templates
        assert before == after
    finally:
        runtime.close()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [_UNSET, None, {}, "", {"Bad Header": "{value}"}])
async def test_secret_headers_reject_invalid_input(tmp_path, headers):
    rootfs = tmp_path / "rootfs"
    rootfs.mkdir()
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path / "runtime")))
    try:
        with pytest.raises(Exception, match="header"):
            await runtime.create(
                boxlite.BoxOptions(
                    rootfs_path=str(rootfs), secrets=[secret_with_headers(headers)]
                )
            )
    finally:
        runtime.close()
