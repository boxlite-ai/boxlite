"""
The runtime image handle through the native binding (no VM required).

A local runtime with an empty cache answers get, remove and usage without a
pull; a REST runtime is pointed at a loopback stub so the shapes it returns
come from a real response, not from the test.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import pytest_asyncio

import boxlite

pytestmark = pytest.mark.skipif(
    not hasattr(boxlite, "Boxlite"), reason="native Rust extension not available"
)


@pytest_asyncio.fixture
async def local_runtime(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    yield runtime
    await runtime.shutdown()


class TestOnALocalCache:
    @pytest.mark.asyncio
    async def test_get_of_a_name_the_cache_does_not_hold_is_not_found(
        self, local_runtime
    ):
        with pytest.raises(boxlite.NotFoundError) as caught:
            await local_runtime.images.get("quay.io/acme/app")

        assert "quay.io/acme/app" in str(caught.value)

    @pytest.mark.asyncio
    async def test_remove_of_a_name_the_cache_does_not_hold_is_not_found(
        self, local_runtime
    ):
        with pytest.raises(boxlite.NotFoundError):
            await local_runtime.images.remove("quay.io/acme/app")

    @pytest.mark.asyncio
    async def test_a_tagged_reference_is_refused_with_the_name_to_pass(
        self, local_runtime
    ):
        with pytest.raises(boxlite.InvalidArgumentError) as caught:
            await local_runtime.images.remove("quay.io/acme/app:v1")

        assert "such as 'quay.io/acme/app'" in str(caught.value)

    @pytest.mark.asyncio
    async def test_usage_is_unsupported(self, local_runtime):
        with pytest.raises(boxlite.UnsupportedError):
            await local_runtime.images.usage()


DETAIL = {
    "name": "quay.io/acme/app",
    "tags": ["v1"],
    "curated": False,
    "versions": [
        {
            "digest": "sha256:aa",
            "size_bytes": 4096,
            "source_ref": "quay.io/acme/app:v1",
            "recorded_at": "2026-09-01T00:00:00Z",
        }
    ],
}
USAGE = {"count": 3, "limit": 20, "known_bytes": 8192}
ROUTES = {
    "/v1/images/quay.io%2Facme%2Fapp": DETAIL,
    "/v1/images/usage": USAGE,
}


@pytest.fixture
def catalog():
    """A server answering the box API's image routes with fixed bodies.

    Yields its URL and the (method, path) of every request it received.
    """
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_DELETE(self):
            requests.append(("DELETE", self.path))
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            requests.append(("GET", self.path))
            body = ROUTES.get(self.path)
            payload = json.dumps(
                body if body is not None else {"error": {"message": self.path}}
            ).encode()
            self.send_response(200 if body is not None else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", requests
    server.shutdown()
    server.server_close()


class TestOnARestRuntime:
    @pytest.mark.asyncio
    async def test_get_reads_the_name_and_its_versions(self, catalog):
        url, _ = catalog
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))

        detail = await runtime.images.get("quay.io/acme/app")

        assert isinstance(detail, boxlite.ImageDetail)
        assert (detail.name, detail.tags, detail.curated) == (
            "quay.io/acme/app",
            ["v1"],
            False,
        )
        [version] = detail.versions
        assert isinstance(version, boxlite.ImageVersion)
        assert (version.digest, version.size_bytes, version.source_ref) == (
            "sha256:aa",
            4096,
            "quay.io/acme/app:v1",
        )
        assert version.recorded_at.startswith("2026-09-01T00:00:00")

    @pytest.mark.asyncio
    async def test_usage_reads_count_limit_and_bytes(self, catalog):
        url, _ = catalog
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))

        usage = await runtime.images.usage()

        assert isinstance(usage, boxlite.ImageUsage)
        assert (usage.count, usage.limit, usage.known_bytes) == (3, 20, 8192)

    @pytest.mark.asyncio
    async def test_remove_deletes_the_name_as_one_segment(self, catalog):
        url, requests = catalog
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))

        await runtime.images.remove("quay.io/acme/app")

        assert requests == [("DELETE", "/v1/images/quay.io%2Facme%2Fapp")]


class TestTheSyncFace:
    def test_a_sync_runtime_reaches_a_rest_server(self, catalog):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")

        url, _ = catalog
        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            usage = runtime.images.usage()
            detail = runtime.images.get("quay.io/acme/app")

        assert (usage.count, usage.limit) == (3, 20)
        assert detail.tags == ["v1"]
