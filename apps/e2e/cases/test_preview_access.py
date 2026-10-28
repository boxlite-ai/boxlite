"""POL-1221: real public preview and private authorization on all three entrances."""
import json
import os
from urllib.parse import urlsplit, urlunsplit

import boxlite
import pytest

from e2e_auth import discover_path_prefix, load_profile
from network_fixtures import PORT, eventually_status, prepare, ready, service_box
from preview import access, api, require

TRANSPORTS = ("http", "ws", "connect")


@pytest.mark.parametrize("transport", TRANSPORTS)
async def test_preview_public_requires_a_port_declaration(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box)
        uri = tunnel.uri()
        await ready(uri, marker)
        response = await access(uri, transport)
        assert response.status == (101 if transport == "ws" else 200)
        assert marker in response.body
        target = urlsplit(uri)
        undeclared = urlunsplit(target._replace(netloc=target.netloc.replace(f"{PORT}-", f"{PORT + 1}-", 1)))
        assert (await access(undeclared, transport)).status == 404


async def test_preview_default_inbound_prevents_prepare(rt, image, e2e_auth):
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        assert (await box.info()).network.inbound.mode == "disabled"
        response = await api(e2e_auth, "POST", f"boxes/{box.id}/network/tunnel?port={PORT}", {})
        assert response.status == 409
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.parametrize("transport", TRANSPORTS)
@pytest.mark.parametrize("credential", ["none", "bad-token", "token", "platform", "bearer"])
async def test_preview_private_credentials(rt, image, e2e_auth, transport, credential):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        token = tunnel.token()
        require(bool(token) and not tunnel.is_public(), "private prepare returned the wrong descriptor")
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": token})
        headers = {
            "none": {}, "bad-token": {"X-BoxLite-Access-Token": "blt_" + "A" * 43},
            "token": {"X-BoxLite-Access-Token": token},
            "platform": {"X-BoxLite-Authorization": f"Bearer {e2e_auth.token}"},
            "bearer": {"Authorization": f"Bearer {e2e_auth.token}"},
        }[credential]
        reply = await access(tunnel.uri(), transport, headers)
        expected = 401 if credential in ("none", "bad-token") else (101 if transport == "ws" else 200)
        assert reply.status == expected
        if expected != 401:
            assert marker in reply.body


async def test_preview_private_descriptor_and_mode_conflict(rt, image, e2e_auth):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        repeated = await prepare(box, public=False)
        require(repeated.uri() == tunnel.uri() and not repeated.is_public(), "repeat changed descriptor")
        require("*" in repeated.token() and repeated.token() != tunnel.token(), "repeat exposed full token")
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        response = await api(e2e_auth, "POST", f"boxes/{box.id}/network/tunnel?port={PORT}", {"isPublic": True})
        assert response.status == 409
        assert (await access(tunnel.uri())).status == 401


@pytest.mark.parametrize("transport", TRANSPORTS)
async def test_preview_inbound_overrides_private_credentials(rt, image, e2e_auth, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        headers = {"X-BoxLite-Access-Token": tunnel.token()}
        await ready(tunnel.uri(), marker, headers)
        before = (await box.info()).network.outbound
        await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="disabled"))
        for credentials in ({}, headers, {"X-BoxLite-Authorization": f"Bearer {e2e_auth.token}"}):
            await eventually_status(tunnel.uri(), transport, 403, credentials)
        after = (await box.info()).network.outbound
        assert (after.mode, after.allow_net) == (before.mode, before.allow_net)
        await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="enabled"))
        await eventually_status(tunnel.uri(), transport, 101 if transport == "ws" else 200, headers)


@pytest.mark.parametrize("transport", TRANSPORTS)
async def test_preview_private_token_is_scoped_to_port_and_box(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        first, second = await prepare(box, public=False), await prepare(box, public=False, port=PORT + 1)
        response = await ready(first.uri(), marker, {"X-BoxLite-Access-Token": first.token()})
        credentials = [{"X-BoxLite-Access-Token": first.token()},
                       {"Cookie": response.session_cookie().split(";", 1)[0]}]
        await ready(second.uri(), marker + b"-second", {"X-BoxLite-Access-Token": second.token()})
        for credential in credentials:
            assert (await access(second.uri(), transport, credential)).status == 401
        async with service_box(rt, image) as (other, other_marker):
            other_tunnel = await prepare(other, public=False)
            await ready(other_tunnel.uri(), other_marker, {"X-BoxLite-Access-Token": other_tunnel.token()})
            for credential in credentials:
                assert (await access(other_tunnel.uri(), transport, credential)).status == 401


@pytest.mark.parametrize("identity", ["readonly", "foreign"])
async def test_preview_private_identity_permissions(rt, image, e2e_auth, identity):
    name = f"BOXLITE_E2E_{identity.upper()}_PROFILE"
    if not os.environ.get(name):
        if os.environ.get("BOXLITE_E2E_REQUIRE_IDENTITIES") == "1":
            pytest.fail(f"required identity is not configured: {name}")
        pytest.skip(f"not exercised: {name} must name an existing E2E credential profile")
    profile = load_profile(os.environ[name])
    token = profile.get("api_key") or profile.get("access_token")
    require(bool(token), "identity profile has no credential")
    require(profile.get("url", "").rstrip("/") == e2e_auth.url.rstrip("/"),
            "identity profile must use the owner's API URL")
    prefix = discover_path_prefix(e2e_auth.url, token)
    require(isinstance(prefix, str) and bool(prefix), "identity has no organization")
    require((prefix == e2e_auth.path_prefix) == (identity == "readonly"),
            f"{identity} profile has the wrong organization relationship")
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        before = await api(e2e_auth, "GET", f"boxes/{box.id}")
        assert before.status == 200
        for transport in TRANSPORTS:
            reply = await access(tunnel.uri(), transport, {"X-BoxLite-Authorization": f"Bearer {token}"})
            assert reply.status == (401 if identity == "foreign" else (101 if transport == "ws" else 200))
            if identity == "readonly":
                assert reply.body == (marker + b":preview-e2e" if transport == "ws" else marker)
        for method, suffix, body in [
            ("POST", f"tunnel?port={PORT}", {"isPublic": False}),
            ("DELETE", f"tunnel?port={PORT}", None),
            ("PUT", "inbound", {"mode": "disabled"}),
            ("PUT", "outbound", {"mode": "disabled"}),
        ]:
            reply = await api(e2e_auth, method, f"boxes/{box.id}/network/{suffix}", body, token)
            assert reply.status in ((403,) if identity == "readonly" else (403, 404))
        after = await api(e2e_auth, "GET", f"boxes/{box.id}")
        assert after.status == 200
        assert json.loads(after.body)["network"] == json.loads(before.body)["network"]
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
