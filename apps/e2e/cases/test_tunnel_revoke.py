"""POL-1221: revoke prepared endpoints without accidentally preparing them again."""
import asyncio

import boxlite
import pytest

from network_fixtures import PORT, eventually_status, prepare, ready, service_box, state
from preview import access, api, open_stream, require


@pytest.mark.parametrize("public", [True, False])
@pytest.mark.parametrize("transport", ["http", "ws", "connect"])
async def test_tunnel_revoke_blocks_new_access_only_on_its_port(rt, image, public, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=public)
        other = await prepare(box, port=PORT + 1)
        headers = {} if public else {"X-BoxLite-Access-Token": tunnel.token()}
        await ready(tunnel.uri(), marker, headers)
        await ready(other.uri(), marker + b"-second")
        await box.network.revoke_tunnel(PORT)
        await eventually_status(tunnel.uri(), transport, 404, headers)
        reply = await access(other.uri(), transport)
        assert reply.status == (101 if transport == "ws" else 200)
        assert marker + b"-second" in reply.body
        await box.network.revoke_tunnel(PORT)
        await box.network.revoke_tunnel(PORT + 2)
        assert (await access(tunnel.uri(), transport, headers)).status == 404


async def test_tunnel_recreate_rotates_token_and_invalidates_cookie(rt, image):
    async with service_box(rt, image) as (box, marker):
        old = await prepare(box, public=False)
        old_token = old.token()
        reply = await ready(old.uri(), marker, {"X-BoxLite-Access-Token": old_token})
        cookie = reply.session_cookie().split(";", 1)[0]
        await box.network.revoke_tunnel(PORT)
        await eventually_status(old.uri(), "http", 404, {"Cookie": cookie})
        new = await prepare(box, public=False)
        require(old.uri() == new.uri() and old_token != new.token(), "recreate did not rotate token at the same URI")
        for credential in ({"X-BoxLite-Access-Token": old_token}, {"Cookie": cookie}):
            assert (await access(new.uri(), headers=credential)).status == 401
        await ready(new.uri(), marker, {"X-BoxLite-Access-Token": new.token()})


@pytest.mark.parametrize("transport", ["ws", "connect"])
async def test_tunnel_revoke_preserves_established_stream(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        headers = {"X-BoxLite-Access-Token": tunnel.token()}
        await ready(tunnel.uri(), marker, headers)
        wire, reply = await open_stream(tunnel.uri(), transport, headers)
        try:
            assert reply.status == (101 if transport == "ws" else 200)
            await box.network.revoke_tunnel(PORT)
            await eventually_status(tunnel.uri(), transport, 404, headers)
            if transport == "ws":
                assert await asyncio.to_thread(wire.echo) == marker + b":preview-e2e"
            else:
                guest = await asyncio.to_thread(wire.request, "GET", "/")
                assert guest.status == 200
                assert await asyncio.to_thread(wire.exact, int(guest.headers["content-length"])) == marker
        finally:
            wire.close()


@pytest.mark.parametrize("condition", ["stopped", "inbound-disabled"])
async def test_tunnel_can_be_revoked_while_unreachable(rt, image, e2e_auth, condition):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        if condition == "stopped":
            await box.stop()
            await state(rt, box.id, "stopped")
        else:
            await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="disabled"))
        reply = await api(e2e_auth, "DELETE", f"boxes/{box.id}/network/tunnel?port={PORT}")
        assert reply.status == 204
        if condition == "stopped":
            await box.start()
        else:
            await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="enabled"))
        await eventually_status(tunnel.uri(), "http", 404, {"X-BoxLite-Access-Token": tunnel.token()})
