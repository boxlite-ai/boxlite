"""
The runtime's registry logins through the native binding (no VM required).

A local runtime refuses the handle outright; a REST runtime is pointed at a
loopback stub, so what it sends and reads crosses a real HTTP boundary.
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

LOGIN_ID = "0aaa0000-0000-4000-8000-000000000001"
PASSWORD = "ghp_not-a-real-token"
LOGIN = {
    "id": LOGIN_ID,
    "registry_host": "ghcr.io",
    "repository_prefix": "acme/",
    "username": "acme-bot",
    "created_by": None,
    "created_at": "2026-09-01T00:00:00Z",
}


@pytest_asyncio.fixture
async def local_runtime(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    yield runtime
    await runtime.shutdown()


class TestOnALocalRuntime:
    def test_the_handle_is_unsupported_and_names_the_local_option(self, local_runtime):
        with pytest.raises(boxlite.UnsupportedError) as caught:
            _ = local_runtime.registries

        assert "image_registries" in str(caught.value)


@pytest.fixture
def server():
    """A box API stub answering each (method, path) with a fixed reply.

    Yields its URL, the replies to fill in, and every (method, path, body) it
    received. A route with no reply answers 404.
    """
    replies: dict = {}
    requests: list = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            requests.append((self.command, self.path, body))
            status, reply = replies.get(
                (self.command, self.path), (404, {"message": "no route"})
            )
            payload = b"" if reply is None else json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{http.server_address[1]}", replies, requests
    http.shutdown()
    http.server_close()


def registries_on(url):
    return boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url)).registries


class TestOnARestRuntime:
    @pytest.mark.asyncio
    async def test_list_reads_each_login(self, server):
        url, replies, _ = server
        replies[("GET", "/v1/registries")] = (200, {"registries": [LOGIN]})

        [login] = await registries_on(url).list()

        assert isinstance(login, boxlite.RegistryCredential)
        assert (login.id, login.registry_host, login.repository_prefix) == (
            LOGIN_ID,
            "ghcr.io",
            "acme/",
        )
        assert (login.username, login.created_by) == ("acme-bot", None)
        assert login.created_at.startswith("2026-09-01T00:00:00")

    @pytest.mark.asyncio
    async def test_create_sends_the_login_and_hands_back_no_password(self, server):
        url, replies, requests = server
        # A broken server that echoed the password back.
        replies[("POST", "/v1/registries")] = (201, {**LOGIN, "password": PASSWORD})

        created = await registries_on(url).create(
            registry_host="ghcr.io",
            repository_prefix="acme/",
            username="acme-bot",
            password=PASSWORD,
        )

        [(_, _, body)] = requests
        assert json.loads(body) == {
            "registry_host": "ghcr.io",
            "repository_prefix": "acme/",
            "username": "acme-bot",
            "password": PASSWORD,
        }
        assert created.id == LOGIN_ID
        assert not hasattr(created, "password")
        shows_password = PASSWORD in repr(created)
        assert not shows_password

    @pytest.mark.asyncio
    async def test_create_takes_its_fields_by_keyword_only(self, server):
        url, _, requests = server

        with pytest.raises(TypeError):
            await registries_on(url).create("ghcr.io", "acme-bot", PASSWORD)
        assert requests == []

    @pytest.mark.asyncio
    async def test_a_second_login_for_a_held_prefix_is_already_exists(self, server):
        url, replies, _ = server
        replies[("POST", "/v1/registries")] = (
            409,
            {
                "message": "A credential for ghcr.io/acme/ already exists",
                "code": "already_exists",
            },
        )

        with pytest.raises(boxlite.AlreadyExistsError):
            await registries_on(url).create(
                registry_host="ghcr.io", username="acme-bot", password=PASSWORD
            )

    @pytest.mark.asyncio
    async def test_remove_deletes_the_login_by_id(self, server):
        url, replies, requests = server
        replies[("DELETE", f"/v1/registries/{LOGIN_ID}")] = (204, None)

        await registries_on(url).remove(LOGIN_ID)

        assert [(method, path) for method, path, _ in requests] == [
            ("DELETE", f"/v1/registries/{LOGIN_ID}")
        ]

    @pytest.mark.asyncio
    async def test_remove_of_a_login_in_use_is_invalid_state_naming_the_box(
        self, server
    ):
        url, replies, _ = server
        replies[("DELETE", f"/v1/registries/{LOGIN_ID}")] = (
            409,
            {"message": "cannot be removed while 1 box(es) pull through it: box-1"},
        )

        with pytest.raises(boxlite.InvalidStateError) as caught:
            await registries_on(url).remove(LOGIN_ID)

        assert "box-1" in str(caught.value)

    @pytest.mark.asyncio
    async def test_remove_refuses_an_id_that_is_not_a_uuid_without_a_request(
        self, server
    ):
        url, _, requests = server

        with pytest.raises(boxlite.InvalidArgumentError):
            await registries_on(url).remove("../images")
        assert requests == []


class TestTheSyncFace:
    def test_a_sync_runtime_manages_logins_on_a_rest_server(self, server):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")
        url, replies, requests = server
        replies[("POST", "/v1/registries")] = (201, LOGIN)
        replies[("GET", "/v1/registries")] = (200, {"registries": [LOGIN]})

        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            created = runtime.registries.create(
                registry_host="ghcr.io", username="acme-bot", password=PASSWORD
            )
            listed = runtime.registries.list()

        assert created.id == LOGIN_ID
        assert [login.id for login in listed] == [LOGIN_ID]
        # Without a prefix, none is sent: the server covers the whole registry.
        assert "repository_prefix" not in json.loads(requests[0][2])
