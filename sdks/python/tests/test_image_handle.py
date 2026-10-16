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

    @pytest.mark.asyncio
    async def test_create_alias_is_unsupported(self, local_runtime):
        with pytest.raises(boxlite.UnsupportedError):
            await local_runtime.images.create_alias("quay.io/acme/app", "stable", NEW)


DETAIL = {
    "name": "quay.io/acme/app",
    "aliases": ["v1"],
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
OLD = "sha256:" + "a" * 64
NEW = "sha256:" + "b" * 64
CREATED = {
    "name": "quay.io/acme/app",
    "aliases": ["stable"],
    "curated": False,
    "versions": [
        {
            "digest": NEW,
            "size_bytes": None,
            "source_ref": "quay.io/acme/app:v2",
            "recorded_at": "2026-09-02T00:00:00Z",
            "aliases": ["stable"],
            "last_used_at": "2026-09-03T00:00:00Z",
            "upstream_missing_at": None,
        }
    ],
    "history": [
        {
            "alias": "stable",
            "from_digest": OLD,
            "to_digest": NEW,
            "actor": "user-1",
            "recorded_at": "2026-09-04T00:00:00Z",
        }
    ],
}


@pytest.fixture
def catalog():
    """A server answering the box API's image routes with fixed bodies.

    Yields its URL and the (method, path) of every request it received, with
    the JSON body of a PUT.
    """
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(("POST", self.path, body))
            payload = json.dumps(CREATED).encode()
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

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
        assert (detail.name, detail.aliases, detail.curated) == (
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

    @pytest.mark.asyncio
    async def test_create_alias_posts_the_alias_and_reads_the_image(self, catalog):
        url, requests = catalog
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))

        detail = await runtime.images.create_alias("quay.io/acme/app", "stable", NEW)

        assert requests == [
            (
                "POST",
                "/v1/images/quay.io%2Facme%2Fapp/aliases",
                {"alias": "stable", "digest": NEW},
            )
        ]
        [version] = detail.versions
        assert (version.aliases, version.upstream_missing_at) == (["stable"], None)
        assert version.last_used_at.startswith("2026-09-03T00:00:00")
        [event] = detail.history
        assert isinstance(event, boxlite.ImageAliasEvent)
        assert (event.alias, event.from_digest, event.to_digest, event.actor) == (
            "stable",
            OLD,
            NEW,
            "user-1",
        )
        assert event.recorded_at.startswith("2026-09-04T00:00:00")

    @pytest.mark.asyncio
    async def test_delete_alias_removes_only_the_named_binding(self, catalog):
        url, requests = catalog
        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        await runtime.images.delete_alias("quay.io/acme/app", "stable")
        assert requests == [
            ("DELETE", "/v1/images/quay.io%2Facme%2Fapp/aliases/stable")
        ]


class TestTheSyncFace:
    def test_a_sync_runtime_reaches_a_rest_server(self, catalog):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")

        url, _ = catalog
        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            usage = runtime.images.usage()
            detail = runtime.images.get("quay.io/acme/app")
            moved = runtime.images.create_alias("quay.io/acme/app", "stable", NEW)

        assert (usage.count, usage.limit) == (3, 20)
        assert detail.aliases == ["v1"]
        assert [event.to_digest for event in moved.history] == [NEW]
