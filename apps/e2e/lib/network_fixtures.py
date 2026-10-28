"""REST-backed service fixtures shared by network acceptance cases."""
import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path
import uuid

import boxlite

from preview import PreviewHeaders, PreviewURL, access, require

PORT = 18080
PROGRAM = (Path(__file__).parents[1] / "fixtures/service_in_box_server.py").read_bytes()


@asynccontextmanager
async def service_box(rt, image, **options):
    marker = f"e2e-{uuid.uuid4().hex}".encode()
    code = f"import base64;exec(base64.b64decode({base64.b64encode(PROGRAM).decode()!r}))"
    settings = dict(image=image, auto_remove=False, auto_resume=False,
                    network=boxlite.NetworkSpec(inbound=boxlite.InboundNetworkSpec(mode="enabled")),
                    entrypoint=["python3", "-u", "-c", code, str(PORT), marker.decode(), str(PORT + 1)])
    box = await rt.create(boxlite.BoxOptions(**{**settings, **options}))
    try:
        yield box, marker
    finally:
        await rt.remove(box.id, force=True)


async def prepare(box, *, public=True, port=PORT):
    return await box.network.tunnel(("127.0.0.1", port), boxlite.TunnelOptions(is_public=public))


async def ready(uri, marker, headers=None):
    """Only readiness retries; authorization failures never become a retry/skip."""
    uri, headers = PreviewURL(uri), PreviewHeaders(headers or {})
    deadline = asyncio.get_running_loop().time() + 35
    while True:
        response = await access(uri, headers=headers)
        if response.status == 200:
            require(response.body == marker, "preview reached the wrong guest")
            return response
        require(response.status in (502, 503), f"preview readiness returned {response.status}")
        require(asyncio.get_running_loop().time() < deadline, "guest service never became ready")
        await asyncio.sleep(0.2)


async def state(rt, box_id, expected):
    deadline = asyncio.get_running_loop().time() + 60
    while (await rt.get_info(box_id)).state.status != expected:
        require(asyncio.get_running_loop().time() < deadline, f"box never became {expected}")
        await asyncio.sleep(0.2)


async def eventually_status(uri, transport, expected: int | tuple[int, ...], headers=None):
    # Three-second server cache contract, plus one second for request scheduling.
    uri, headers = PreviewURL(uri), PreviewHeaders(headers or {})
    expected_statuses = (expected,) if isinstance(expected, int) else expected
    deadline = asyncio.get_running_loop().time() + 4
    while True:
        reply = await access(uri, transport, headers)
        if reply.status in expected_statuses:
            require(asyncio.get_running_loop().time() <= deadline,
                    "proxy authorization change exceeded cache window and scheduling allowance")
            return reply
        require(asyncio.get_running_loop().time() < deadline,
                f"expected proxy status {expected}, got {reply.status} after cache window")
        await asyncio.sleep(0.1)
