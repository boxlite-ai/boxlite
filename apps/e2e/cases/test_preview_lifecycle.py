"""POL-1221: authorization precedes wake; declarations survive stop/start."""
import asyncio

import boxlite
import pytest

from network_fixtures import PORT, eventually_status, prepare, ready, service_box, state
from preview import Wire, access, require


@pytest.mark.parametrize("transport", ["http", "ws", "connect"])
@pytest.mark.parametrize("auto_resume", [False, True])
async def test_preview_private_authorizes_before_waking(rt, image, transport, auto_resume):
    async with service_box(rt, image, auto_resume=auto_resume) as (box, marker):
        tunnel = await prepare(box, public=False)
        headers = {"X-BoxLite-Access-Token": tunnel.token()}
        initial = await ready(tunnel.uri(), marker, headers)
        cookie = initial.session_cookie().split(";", 1)[0]
        await box.stop()
        await state(rt, box.id, "stopped")
        # Neither prepare nor unauthorized traffic may wake the box.
        if auto_resume:
            repeated = await prepare(box, public=False)
            require(repeated.uri() == tunnel.uri(), "stopped prepare changed URI")
        else:
            with pytest.raises(boxlite.InvalidStateError, match="not running"):
                await prepare(box, public=False)
        for credentials in ({}, {"X-BoxLite-Access-Token": "blt_" + "A" * 43}):
            assert (await access(tunnel.uri(), transport, credentials)).status == 401
            assert (await box.info()).state.status == "stopped"
        deadline = asyncio.get_running_loop().time() + 60
        while True:
            reply = await access(tunnel.uri(), transport, headers)
            if not auto_resume:
                assert reply.status == 503
                if transport == "http":
                    assert b"BOX_STOPPED" in reply.body
                assert (await box.info()).state.status == "stopped"
                await box.start()
                break
            if reply.status != 503:
                assert reply.status == (101 if transport == "ws" else 200)
                assert marker in reply.body
                break
            require(asyncio.get_running_loop().time() < deadline, "authorized request never woke guest")
            await asyncio.sleep(0.2)
        await state(rt, box.id, "running")
        # The same token and session remain valid after a VM restart.
        await ready(tunnel.uri(), marker, headers)
        assert (await access(tunnel.uri(), headers={"Cookie": cookie})).body == marker


@pytest.mark.parametrize("change", ["invalid-proof", "revoke"])
async def test_preview_private_reauthorizes_each_keepalive_request(rt, image, change):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        headers = {"X-BoxLite-Access-Token": tunnel.token(), "X-BoxLite-Skip-Preview-Warning": "true"}
        await ready(tunnel.uri(), marker, headers)
        wire = await asyncio.to_thread(Wire, tunnel.uri())
        try:
            reply = await asyncio.to_thread(wire.request, "GET", "/keepalive", headers)
            assert reply.status == 200
            assert await asyncio.to_thread(wire.exact, int(reply.headers["content-length"])) == marker
            if change == "revoke":
                await box.network.revoke_tunnel(PORT)
                await eventually_status(tunnel.uri(), "http", 404, headers)
                expected = 404
            else:
                headers = {**headers, "X-BoxLite-Access-Token": "blt_" + "A" * 43}
                expected = 401
            reply = await asyncio.to_thread(wire.request, "GET", "/keepalive", headers)
            assert reply.status == expected
        finally:
            wire.close()


async def test_preview_private_sdk_forward_cannot_reprepare_after_revoke(rt, image):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        unopened = await prepare(box, public=False)
        forward = await tunnel.forward(boxlite.SocketAddress.tcp("127.0.0.1", 0))
        try:
            address = forward.local_addr()
            host, port = address.host, address.port
            local_uri = f"http://{host}:{port}"
            assert (await access(local_uri)).body == marker
            await box.network.revoke_tunnel(PORT)
            await eventually_status(tunnel.uri(), "http", 404)
            with pytest.raises(RuntimeError, match="404|not found"):
                await unopened.connect()
            # The listener must still accept TCP, then refuse the revoked upstream.
            wire = await asyncio.to_thread(Wire, local_uri)
            try:
                with pytest.raises((AssertionError, ConnectionResetError)):
                    await asyncio.to_thread(wire.request, "GET", "/")
            finally:
                wire.close()
            assert (await access(tunnel.uri())).status == 404
        finally:
            await forward.close()


@pytest.mark.parametrize("transport", ["http", "ws", "connect"])
async def test_preview_deleted_box_invalidates_its_uri(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        credentials = {"X-BoxLite-Access-Token": tunnel.token()}
        await ready(tunnel.uri(), marker, credentials)
    # Missing-box inbound metadata denies access with 403 after cache expiry;
    # a cached enabled mode reaches the missing tunnel and returns 404.
    await eventually_status(tunnel.uri(), transport, (403, 404), credentials)


@pytest.mark.parametrize("restriction,status", [("revoked", 404), ("inbound-disabled", 403)])
async def test_preview_denied_declaration_does_not_wake_guest(rt, image, restriction, status):
    async with service_box(rt, image, auto_resume=True) as (box, marker):
        tunnel = await prepare(box, public=False)
        credentials = {"X-BoxLite-Access-Token": tunnel.token()}
        await ready(tunnel.uri(), marker, credentials)
        if restriction == "revoked":
            await box.network.revoke_tunnel(PORT)
        else:
            await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="disabled"))
        # Observe cache convergence before asserting that denied traffic cannot
        # wake a stopped guest. A request during the old allow cache is admitted.
        await eventually_status(tunnel.uri(), "http", status, credentials)
        await box.stop()
        await state(rt, box.id, "stopped")
        for transport in ("http", "ws", "connect"):
            await eventually_status(tunnel.uri(), transport, status, credentials)
            assert (await box.info()).state.status == "stopped"
