"""CPU limits across the Python binding and its production REST client."""

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
@pytest.mark.parametrize("kwargs", [{}, {"cpu_limit": None}, {"cpu_limit": 0.125}])
async def test_cpu_limit_requests_and_info(kwargs):
    import boxlite

    requests = []
    reply = {
        "box_id": "cpu-limited",
        "name": None,
        "status": "running",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "image": "alpine",
        "cpus": 2,
        "memory_mib": 512,
        "cpu_limit": kwargs.get("cpu_limit"),
    }

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            requests.append(
                (
                    self.command,
                    self.path,
                    json.loads(body) if body else None,
                    self.headers.get("Content-Type"),
                )
            )
            payload = json.dumps(reply).encode()
            self.send_response(404 if self.path == "/v1/config" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = answer

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        runtime = boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(url=f"http://127.0.0.1:{server.server_port}")
        )
        box = await runtime.create(boxlite.BoxOptions("alpine", None, 2, 512, **kwargs))
        info = await box.info()
        assert info.cpu_limit == kwargs.get("cpu_limit")
        assert info.cpus == 2
        expected = [("POST", "/v1/boxes"), ("GET", "/v1/boxes/cpu-limited")]
        assert [(method, path) for method, path, _, _ in requests] == expected
        _, _, body, content_type = next(r for r in requests if r[0] == "POST")
        assert content_type == "application/json"
        assert body["cpus"] == 2 and body["memory_mib"] == 512
        if kwargs.get("cpu_limit") is None:
            assert "cpu_limit" not in body
        else:
            assert body["cpu_limit"] == 0.125
        assert "cpu_limit_millicpu" not in body
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_cpu_limit_simple_wrappers_preserve_positional_arguments():
    from boxlite import SimpleBox, SyncSimpleBox

    # Supplying an inert runtime keeps construction lazy and independent of KVM.
    async_box = SimpleBox("alpine", None, 512, 2, object(), cpu_limit=0.125)
    sync_box = SyncSimpleBox("alpine", None, 512, 2, object(), cpu_limit=0.125)
    for options in [async_box._box_options, sync_box._box_opts]:
        assert options.cpus == 2 and options.memory_mib == 512
        assert options.cpu_limit == 0.125


@pytest.mark.asyncio
async def test_cpu_limit_unsupported_error_names_rejected_field():
    import boxlite

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            requests.append(
                (self.command, self.path, json.loads(body) if body else None)
            )
            status, value = 400, {"message": "property cpu_limit should not exist"}
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = answer

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        runtime = boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(url=f"http://127.0.0.1:{server.server_port}")
        )
        with pytest.raises(
            boxlite.UnsupportedError, match="cpu_limit.*should not exist"
        ):
            await runtime.create(boxlite.BoxOptions("alpine", cpu_limit=0.125))
        assert len(requests) == 1
        assert requests[0][:2] == ("POST", "/v1/boxes")
        assert requests[0][2]["cpu_limit"] == 0.125
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
