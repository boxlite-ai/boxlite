"""Opt-in deployment tests for official hostnames (feature PR #1597).

Run explicitly with make test:e2e:proxy. This filename deliberately stays out
of ordinary test_*.py discovery until the endpoint API is deployed.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from e2e_auth import request_json
from proxy_client import ProxyClient
from test_sdk_tunnel import _start_service, _wait_for_http

import boxlite

pytestmark = [pytest.mark.e2e, pytest.mark.asyncio]
PORT = 18080


async def _api(method, path, body=None, expected=200):
    status, result = await asyncio.to_thread(request_json, method, path, body)
    # Avoid serializing API responses containing preview credentials on failure.
    assert status == expected, f"{method} {path}: expected {expected}, got {status}"
    return result


async def _bind(name, box, port=PORT):
    return await _api(
        "PUT", f"/box-endpoints/{name}", {"boxIdOrName": box.id, "port": port}
    )


async def _preview_token(box):
    preview = await _api("GET", f"/box/{box.id}/ports/{PORT}/preview-url")
    assert preview.get("token"), "Preview API did not return a guest access token"
    return preview["token"]


def _options(image, public):
    return boxlite.BoxOptions(
        image=image,
        network=boxlite.NetworkSpec(
            outbound=boxlite.OutboundNetworkSpec(mode="enabled"),
            inbound=boxlite.InboundNetworkSpec(
                mode="enabled" if public else "disabled"
            ),
        ),
    )


async def _cleanup(rt, boxes, name, bound):
    failures = []
    if bound:
        try:
            status, _ = await asyncio.to_thread(
                request_json, "DELETE", f"/box-endpoints/{name}"
            )
            if status != 204:
                failures.append(f"endpoint revocation returned {status}")
        except Exception as exc:  # noqa: BLE001 - finish all cleanup before failing
            failures.append(f"endpoint cleanup: {type(exc).__name__}")
    for box in reversed(boxes):
        try:
            await rt.remove(box.id, force=True)
        except Exception as exc:  # noqa: BLE001 - finish all cleanup before failing
            failures.append(f"box {box.id} cleanup: {type(exc).__name__}")
    assert not failures, "; ".join(failures)


async def test_official_endpoint_public_http_websocket_rebind_revoke(
    rt, image, record_testsuite_property
):
    """Guest-generated responses must arrive through the issued hostname."""
    name = "e2e-" + uuid.uuid4().hex[:20]
    markers = [(name + suffix).encode() for suffix in ("-a", "-b", "-port")]
    boxes = []
    bound = False
    record_testsuite_property(
        "source_sha", os.environ.get("BOXLITE_E2E_SOURCE_SHA", "external-deployment")
    )
    record_testsuite_property(
        "proxy_dns",
        "dial-override"
        if os.environ.get("BOXLITE_E2E_PROXY_CONNECT_HOST")
        else "system-resolver",
    )
    try:
        # Fail immediately on a deployment missing #1597, before creating any VM.
        await _api("GET", "/box-endpoints")
        for marker in markers[:2]:
            box = await rt.create(_options(image, public=True))
            boxes.append(box)
            await _start_service(box, PORT, marker)
            await _wait_for_http(box, PORT, marker)
        endpoint = await _bind(name, boxes[0])
        bound = True
        url = endpoint["url"]
        record_testsuite_property("endpoint_url", url)
        client = ProxyClient(url)
        assert await asyncio.to_thread(client.get, "/marker.txt") == (200, markers[0])
        assert (
            await asyncio.to_thread(client.websocket_echo, b"probe")
            == markers[0] + b":probe"
        )

        await _start_service(boxes[0], PORT + 1, markers[2])
        await _wait_for_http(boxes[0], PORT + 1, markers[2])
        assert (await _bind(name, boxes[0], PORT + 1))["url"] == url
        assert await asyncio.to_thread(client.get) == (200, markers[2])

        assert (await _bind(name, boxes[1]))["url"] == url
        assert await asyncio.to_thread(client.get) == (200, markers[1])
        await _api("DELETE", f"/box-endpoints/{name}", expected=204)
        assert (await asyncio.to_thread(client.get))[0] == 404

        # The original owner can reactivate its reservation without changing URL.
        assert (await _bind(name, boxes[1]))["url"] == url
        assert await asyncio.to_thread(client.get) == (200, markers[1])
    finally:
        await _cleanup(rt, boxes, name, bound)


async def test_official_endpoint_preserves_private_box_authentication(rt, image):
    name = "e2e-" + uuid.uuid4().hex[:20]
    marker = name.encode()
    boxes = []
    bound = False
    try:
        await _api("GET", "/box-endpoints")
        box = await rt.create(_options(image, public=False))
        boxes.append(box)
        await _start_service(box, PORT, marker)
        await _wait_for_http(box, PORT, marker)
        endpoint = await _bind(name, box)
        bound = True
        anonymous = ProxyClient(endpoint["url"])
        status, body = await asyncio.to_thread(anonymous.get)
        assert status == 307 and marker not in body, (
            f"Private endpoint returned {status}"
        )
        client = ProxyClient(endpoint["url"], await _preview_token(box))
        assert await asyncio.to_thread(client.get) == (200, marker)
        assert (
            await asyncio.to_thread(client.websocket_echo, b"private")
            == marker + b":private"
        )
    finally:
        await _cleanup(rt, boxes, name, bound)
