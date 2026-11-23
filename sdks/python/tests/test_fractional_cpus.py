"""Fractional CPU allocations across the Python binding and its production REST client."""

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
@pytest.mark.parametrize(
    "kwargs",
    [{}, {"cpus": None}, {"cpus": 2}, {"cpus": 2.0}, {"cpus": 0.125}, {"cpus": 1.5}],
)
async def test_fractional_cpus_requests_and_info(kwargs):
    import boxlite

    requests = []
    reply = {
        "box_id": "fractional",
        "name": None,
        "status": "running",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "image": "alpine",
        "cpus": kwargs.get("cpus") or 1,
        "memory_mib": 512,
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
        box = await runtime.create(
            boxlite.BoxOptions("alpine", memory_mib=512, **kwargs)
        )
        info = await box.info()
        assert isinstance(info.cpus, float)
        assert info.cpus == (kwargs.get("cpus") or 1)
        assert json.loads(repr(info))["cpus"] == info.cpus
        expected = [("POST", "/v1/boxes"), ("GET", "/v1/boxes/fractional")]
        assert [(method, path) for method, path, _, _ in requests] == expected
        _, _, body, content_type = next(r for r in requests if r[0] == "POST")
        assert content_type == "application/json"
        assert body["memory_mib"] == 512
        if kwargs.get("cpus") is None:
            assert "cpus" not in body
        else:
            assert body["cpus"] == kwargs["cpus"]
        if kwargs.get("cpus") == 2:
            assert isinstance(body["cpus"], int)
        assert "cpu_limit" not in body
        assert "cpu_limit_millicpu" not in body
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_fractional_cpus_async_wrapper_preserves_positional_arguments():
    import boxlite

    runtime = object()
    box = boxlite.SimpleBox("alpine", None, 512, 0.125, runtime)
    assert box._runtime is runtime
    assert box._box_options.cpus == 0.125
    assert box._box_options.memory_mib == 512


def test_fractional_cpus_sync_wrapper_preserves_positional_arguments():
    pytest.importorskip("greenlet")
    import boxlite

    runtime = object()
    box = boxlite.SyncSimpleBox("alpine", None, 512, 0.125, runtime)
    assert box._runtime is runtime
    assert box._box_opts.cpus == 0.125
    assert box._box_opts.memory_mib == 512
