"""RC configuration across real PyO3 and HTTP boundaries; no VM starts."""

import importlib.util
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

NATIVE_ABSENT = importlib.util.find_spec("boxlite.boxlite") is None
pytestmark = pytest.mark.skipif(NATIVE_ABSENT, reason="native extension not built")
if not NATIVE_ABSENT:
    from boxlite.boxlite import (
        AdvancedBoxOptions,
        Boxlite,
        BoxliteRestOptions,
        BoxOptions,
        ContainerCapabilities,
        Options,
    )


BOX = {
    "box_id": "nested-python-box",
    "name": "named",
    "status": "configured",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
    "pid": None,
    "image": "alpine:latest",
    "cpus": 1,
    "memory_mib": 512,
}


@pytest.fixture
def endpoint():
    replies = {}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length)) if length else None
            requests.append(
                (self.command, self.path, self.headers.get("Content-Type"), body)
            )
            status, reply = replies.get((self.command, self.path), (404, {}))
            payload = json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = answer

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", replies, requests
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.mark.asyncio
async def test_nested_virtualization_rest_defaults_preserve_requests(endpoint):
    url, replies, requests = endpoint
    replies["POST", "/v1/boxes"] = (201, BOX)
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    for advanced in [
        None,
        AdvancedBoxOptions(),
        AdvancedBoxOptions(nested_virtualization=False),
    ]:
        await runtime.create(BoxOptions(image="alpine:latest", advanced=advanced))
    assert len(requests) == 3
    assert requests[0] == requests[1] == requests[2]
    assert requests[0][:3] == ("POST", "/v1/boxes", "application/json")
    assert "advanced" not in requests[0][3]


@pytest.mark.asyncio
async def test_nested_virtualization_rest_transfers_and_confirms(endpoint):
    url, replies, requests = endpoint
    replies["GET", "/v1/config"] = (
        200,
        {
            "capabilities": {
                "nested_virtualization_enabled": True,
                "linux_capabilities_enabled": True,
            }
        },
    )
    saved = {**BOX, "advanced": {"nested_virtualization": True}}
    replies["POST", "/v1/boxes"] = (201, saved)
    replies["GET", "/v1/boxes/nested-python-box"] = (200, saved)
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    box = await runtime.create(
        BoxOptions(
            image="alpine:latest",
            advanced=AdvancedBoxOptions(
                nested_virtualization=True,
                capabilities=ContainerCapabilities(),
            ),
        )
    )
    assert [request[:2] for request in requests] == [
        ("GET", "/v1/config"),
        ("GET", "/v1/config"),
        ("POST", "/v1/boxes"),
    ]
    assert requests[-1][3]["advanced"] == {
        "nested_virtualization": True,
        "capabilities": {"add": [], "drop": []},
    }
    assert (await box.info()).advanced.nested_virtualization is True
    replies["GET", "/v1/config"] = (200, {"capabilities": {}})
    before = len(requests)
    with pytest.raises(RuntimeError, match="nested virtualization"):
        await runtime.create(
            BoxOptions(advanced=AdvancedBoxOptions(nested_virtualization=True))
        )
    assert [request[:2] for request in requests[before:]] == [("GET", "/v1/config")]


@pytest.mark.asyncio
async def test_nested_virtualization_rest_rejects_missing_persisted_confirmation(
    endpoint,
):
    url, replies, requests = endpoint
    replies["GET", "/v1/config"] = (
        200,
        {"capabilities": {"nested_virtualization_enabled": True}},
    )
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    for advanced in [None, {"nested_virtualization": False}]:
        saved = dict(BOX)
        if advanced is not None:
            saved["advanced"] = advanced
        replies["POST", "/v1/boxes"] = (201, saved)
        before = len(requests)
        with pytest.raises(RuntimeError, match="nested-python-box"):
            await runtime.create(
                BoxOptions(advanced=AdvancedBoxOptions(nested_virtualization=True))
            )
        assert [request[0] for request in requests[before:]] == ["GET", "POST"]


@pytest.mark.asyncio
async def test_nested_virtualization_local_authorization_is_explicit(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
    for authorized in [False, True]:
        runtime = Boxlite(
            Options(
                home_dir=str(tmp_path / str(authorized)),
                experimental_features=["nested-virtualization"] if authorized else [],
            )
        )
        try:
            options = BoxOptions(
                image="alpine:latest",
                advanced=AdvancedBoxOptions(nested_virtualization=True),
            )
            if authorized:
                box = await runtime.create(options)
                assert (await box.info()).advanced.nested_virtualization is True
            else:
                with pytest.raises(RuntimeError, match="RC feature and is disabled"):
                    await runtime.create(options)
            ordinary = await runtime.create(BoxOptions(image="alpine:latest"))
            assert (await ordinary.info()).advanced.nested_virtualization is False
        finally:
            await runtime.shutdown()


@pytest.mark.parametrize("value", [None, "true", 0, 1, [], {}])
def test_nested_virtualization_boolean_is_not_coerced(value):
    with pytest.raises(TypeError):
        AdvancedBoxOptions(nested_virtualization=value)


@pytest.mark.parametrize(
    "name",
    ["unknown", "nested-virtualization,custom-kernel", "nested-virtualization\0"],
)
def test_nested_virtualization_feature_names_are_atomic(name, tmp_path):
    with pytest.raises(RuntimeError, match="feature"):
        Boxlite(Options(home_dir=str(tmp_path), experimental_features=[name]))


def test_nested_virtualization_default_runtime_retains_authorization(tmp_path):
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import asyncio
import sys
from boxlite.boxlite import Boxlite, Options, BoxOptions, AdvancedBoxOptions
Boxlite.init_default(Options(home_dir=sys.argv[1], experimental_features=["nested-virtualization"]))
async def check():
    rt = Boxlite.default()
    box = await rt.create(BoxOptions(image="alpine:latest", advanced=AdvancedBoxOptions(nested_virtualization=True)))
    assert (await box.info()).advanced.nested_virtualization is True
    await rt.shutdown()
asyncio.run(check())
""",
            str(tmp_path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
