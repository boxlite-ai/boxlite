import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlencode

import pytest

native_present = importlib.util.find_spec("boxlite.boxlite") is not None
if native_present:
    from boxlite import Boxlite, BoxliteRestOptions, MountRequest, SimpleBox
    from boxlite.errors import NotFoundError, UnsupportedError
    from boxlite.sync_api import SyncBoxlite, SyncSimpleBox

pytestmark = pytest.mark.skipif(not native_present, reason="native extension not built")

BOX = "runtime-mounts-box"
TARGET = "/workspace/my files & logs"
BOX_PATH = f"/v1/boxes/{BOX}"
COLLECTION = f"{BOX_PATH}/mounts"
DETAIL = f"{COLLECTION}/by-target?{urlencode({'target': TARGET})}"
START = f"{BOX_PATH}/start"
# Every state the wire answers. `configured` is a mount saved for a stopped
# box's next start.
STATES = ("configured", "preparing", "mounted", "detaching")
BOX_INFO = {
    "box_id": BOX,
    "status": "running",
    "image": "alpine:latest",
    "cpus": 1,
    "memory_mib": 256,
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
    "privileged": False,  # read back before a SimpleBox may reuse the box
}


@pytest.fixture
def mount_server():
    requests = []
    record = {
        "source": "/host/project",
        "target": TARGET,
        "read_only": False,
        "state": "mounted",
    }
    config = {"capabilities": {"runtime_mounts_enabled": True}}
    replies = {
        ("GET", "/v1/config"): (200, config),
        ("GET", BOX_PATH): (200, BOX_INFO),
        ("POST", f"{BOX_PATH}/start"): (200, BOX_INFO),
        ("POST", f"{BOX_PATH}/stop"): (200, BOX_INFO),
        ("POST", COLLECTION): (201, record),
        ("GET", COLLECTION): (200, {"mounts": [record]}),
        ("GET", DETAIL): (200, record),
        ("DELETE", DETAIL): (204, None),
    }

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            size = int(self.headers.get("Content-Length", 0))
            requests.append((self.command, self.path, self.rfile.read(size).decode()))
            status, reply = replies.get((self.command, self.path), (404, {}))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if status != 204:
                self.wfile.write(json.dumps(reply).encode())

        do_GET = do_POST = do_DELETE = answer

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", replies, requests, record
        finally:
            server.shutdown()
            thread.join()


def fields(info):
    return (info.source, info.target, info.read_only, info.state)


def posted_mount(requests):
    [body] = [
        body
        for method, path, body in requests
        if (method, path) == ("POST", COLLECTION)
    ]
    return json.loads(body)


def routes(requests):
    """Every (method, path) the stub answered."""
    return [(method, path) for method, path, _ in requests]


def stopped_box(replies, record):
    """Make the stub answer a stopped box whose mount is only saved."""
    replies["GET", BOX_PATH] = (200, {**BOX_INFO, "status": "stopped"})
    record["state"] = "configured"


@pytest.mark.asyncio
async def test_runtime_mounts_async_and_simple_box(mount_server):
    url, replies, requests, record = mount_server
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    box = await runtime.get(BOX)
    async with SimpleBox(
        image="alpine:latest", runtime=runtime, name=BOX, reuse_existing=True
    ) as simple:
        mount = simple.mount
        added = await mount.add(MountRequest(source="/host/project", target=TARGET))
        assert fields(added) == ("/host/project", TARGET, False, "mounted")
        assert posted_mount(requests) == {
            "source": "/host/project",
            "target": TARGET,
            "read_only": False,
        }
        for state in STATES:
            record["state"] = state
            assert (await box.mount.list())[0].state == state
            assert (await mount.get(TARGET)).state == state
        await mount.remove(TARGET)
        assert ("DELETE", DETAIL, "") in requests
        replies["GET", DETAIL] = (200, None)
        replies["GET", COLLECTION] = (200, {"mounts": []})
        assert await mount.get(TARGET) is None
        assert await mount.list() == []


def test_runtime_mounts_sync_and_simple_box(mount_server):
    url, replies, requests, record = mount_server
    record.update(source="/host/readonly", read_only=True)
    with SyncBoxlite.rest(BoxliteRestOptions(url=url)) as runtime:
        box = runtime.get(BOX)
        with SyncSimpleBox(
            image="alpine:latest", runtime=runtime, name=BOX, reuse_existing=True
        ) as simple:
            mount = simple.mount
            request = MountRequest(
                source="/host/readonly", target=TARGET, read_only=True
            )
            assert fields(mount.add(request)) == (
                "/host/readonly",
                TARGET,
                True,
                "mounted",
            )
            assert posted_mount(requests) == {
                "source": "/host/readonly",
                "target": TARGET,
                "read_only": True,
            }
            assert fields(mount.list()[0]) == fields(mount.get(TARGET))
            mount.remove(TARGET)
            assert ("DELETE", DETAIL, "") in requests
            replies["GET", DETAIL] = (200, None)
            assert box.mount.get(TARGET) is None


@pytest.mark.asyncio
async def test_stopped_add_saves_a_configured_mount_without_starting(mount_server):
    url, replies, requests, record = mount_server
    stopped_box(replies, record)
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    box = await runtime.get(BOX)

    added = await box.mount.add(MountRequest(source="/host/project", target=TARGET))

    assert fields(added) == ("/host/project", TARGET, False, "configured")
    assert posted_mount(requests) == {
        "source": "/host/project",
        "target": TARGET,
        "read_only": False,
    }
    assert fields(await box.mount.get(TARGET)) == fields(added)
    assert [fields(info) for info in await box.mount.list()] == [fields(added)]
    await box.mount.remove(TARGET)
    assert ("DELETE", DETAIL, "") in requests
    replies["GET", DETAIL] = (200, None)
    replies["GET", COLLECTION] = (200, {"mounts": []})
    assert await box.mount.get(TARGET) is None
    assert await box.mount.list() == []
    assert ("POST", START) not in routes(requests)


def test_stopped_add_saves_a_configured_mount_through_the_sync_api(mount_server):
    url, replies, requests, record = mount_server
    stopped_box(replies, record)
    record.update(source="/host/readonly", read_only=True)
    with SyncBoxlite.rest(BoxliteRestOptions(url=url)) as runtime:
        mount = runtime.get(BOX).mount

        added = mount.add(
            MountRequest(source="/host/readonly", target=TARGET, read_only=True)
        )

        assert fields(added) == ("/host/readonly", TARGET, True, "configured")
        assert fields(mount.get(TARGET)) == fields(added)
        assert fields(mount.list()[0]) == fields(added)
        mount.remove(TARGET)
        assert ("DELETE", DETAIL, "") in requests
    assert ("POST", START) not in routes(requests)


@pytest.mark.asyncio
async def test_absent_and_unsupported_mounts_keep_their_error_classes(mount_server):
    url, replies, _, _ = mount_server
    absent = (404, {"error": {"code": "not_found", "message": "no mount"}})
    replies["GET", DETAIL] = absent
    replies["DELETE", DETAIL] = absent
    runtime = Boxlite.rest(BoxliteRestOptions(url=url))
    box = await runtime.get(BOX)

    with pytest.raises(NotFoundError, match="no mount"):
        await box.mount.get(TARGET)
    with pytest.raises(NotFoundError, match="no mount"):
        await box.mount.remove(TARGET)

    replies["GET", "/v1/config"] = (
        200,
        {"capabilities": {"runtime_mounts_enabled": False}},
    )
    with pytest.raises(UnsupportedError, match="runtime directory mounts"):
        await box.mount.get(TARGET)
