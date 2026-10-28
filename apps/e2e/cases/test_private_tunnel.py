"""POL-1221: private-session protocol and sanitization (browser behavior is separate)."""
import json
from urllib.parse import urlsplit

import pytest

from network_fixtures import PORT, prepare, ready, service_box
from preview import access, http, require


async def test_private_tunnel_token_url_sets_scoped_session_and_strips_credentials(rt, image):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        uri, token = tunnel.uri(), tunnel.token()
        await ready(uri, marker, {"X-BoxLite-Access-Token": token})
        reply = await http(uri.rstrip("/") + "/inspect?app=kept&boxlite-access-token=" + token,
                           headers={"Authorization": "Bearer application-credential",
                                    "Cookie": "app-cookie=kept; __Host-boxlite-tunnel-session=old",
                                    "Referer": uri + "?boxlite-access-token=" + token,
                                    "X-BoxLite-Skip-Preview-Warning": "true"})
        assert reply.status == 200
        require(token.encode() not in reply.body, "guest received the tunnel token")
        echo = json.loads(reply.body)
        assert echo["marker"] == marker.decode()
        assert echo["path"] == "/inspect?app=kept"
        headers = {k.lower(): v for k, v in echo["headers"].items()}
        assert headers.get("authorization") == "Bearer application-credential"
        assert headers.get("cookie") == "app-cookie=kept"
        assert not any(k in headers for k in ("x-boxlite-access-token", "x-boxlite-authorization", "referer"))
        cookie = reply.session_cookie()
        require("__Host-boxlite-tunnel-session=" in cookie and "guest-forged" not in cookie, "reserved cookie was not protected")
        for attribute in ("secure", "httponly", "path=/", "samesite=lax"):
            require(attribute in cookie.lower(), "session cookie is missing " + attribute)
        require("domain=" not in cookie.lower(), "session cookie must be host-only")
        assert reply.headers["referrer-policy"] == "no-referrer"
        assert "no-store" in reply.headers["cache-control"]


@pytest.mark.parametrize("transport", ["http", "ws", "connect"])
async def test_private_tunnel_explicit_invalid_proof_cannot_fall_back_to_cookie(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        reply = await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        cookie = reply.session_cookie().split(";", 1)[0]
        for invalid in ({"X-BoxLite-Access-Token": "blt_" + "A" * 43},
                        {"X-BoxLite-Authorization": "Bearer invalid-platform-proof"}):
            assert (await access(tunnel.uri(), transport, {"Cookie": cookie, **invalid})).status == 401


@pytest.mark.parametrize("transport", ["http", "ws"])
async def test_private_tunnel_cookie_rejects_sibling_origin(rt, image, transport):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        reply = await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        cookie = reply.session_cookie().split(";", 1)[0]
        target = urlsplit(tunnel.uri())
        origin = f"{target.scheme}://{target.netloc}"
        good = await access(tunnel.uri(), transport, {"Cookie": cookie, "Origin": origin})
        assert good.status == (101 if transport == "ws" else 200)
        assert marker in good.body
        for proof in ({"Origin": origin.replace(f"{PORT}-", f"{PORT + 1}-", 1)},
                      {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors"}):
            assert (await access(tunnel.uri(), transport, {"Cookie": cookie, **proof})).status == 403
        post = await http(tunnel.uri(), "POST", {"Cookie": cookie, "Origin": "https://sibling.invalid"}, b"x")
        assert post.status == 403


async def test_private_tunnel_rejects_ambiguous_tokens(rt, image):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        token = tunnel.token()
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": token})
        query = tunnel.uri() + "?boxlite-access-token=" + token
        for uri, headers in [(query + "&boxlite-access-token=" + token, {}),
                             (query, {"X-BoxLite-Access-Token": token}),
                             (tunnel.uri(), {"X-BoxLite-Access-Token": token, "X-BoxLite-Authorization": "Bearer other"})]:
            assert (await access(uri, headers=headers)).status == 400


async def test_public_tunnel_ignores_but_strips_platform_proofs(rt, image):
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box)
        await ready(tunnel.uri(), marker)
        require(tunnel.is_public() and tunnel.token() is None, "public descriptor contains a credential")
        reply = await http(tunnel.uri().rstrip("/") + "/inspect?boxlite-access-token=invalid", headers={
            "X-BoxLite-Access-Token": "also-invalid", "X-BoxLite-Authorization": "Bearer invalid",
            "Authorization": "Bearer app", "X-BoxLite-Skip-Preview-Warning": "true",
        })
        assert reply.status == 200
        headers = {k.lower(): v for k, v in json.loads(reply.body)["headers"].items()}
        assert headers["authorization"] == "Bearer app"
        assert "x-boxlite-authorization" not in headers and "x-boxlite-access-token" not in headers
