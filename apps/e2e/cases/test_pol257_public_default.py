"""POL-257 257-7/257-8, POL-205/311/355 — default box visibility and where it's readable.

A box created without an explicit `network`/`public` field defaults to
private (`public: false`) as of POL-355: a service exposed inside a box
must not be reachable from a guessed/constructed preview URL unless the
owner opts in (create-time `public: true`) or holds a `network tunnel`
open (CLI/SDK/dashboard) — that's a renewed live lease, not a token: the
box goes private again within seconds of the tunnel closing or its holder
dying, not on some longer TTL. Before POL-355 the default was `public:
true`. That value is readable via the internal `GET /box/{id}` path but is
absent from the public `GET /v1/boxes/{id}` REST contract the SDKs use —
so a customer orchestrating a fleet through the SDK has no programmatic
way to check a box's visibility without hand-rolling the internal path
(POL-311).

Manually verified live against api.dev.boxlite.ai on 2026-08-24 (pre-POL-355).
"""
from __future__ import annotations

import boxlite
import pytest

from e2e_auth import request_json


@pytest.mark.asyncio
async def test_default_box_is_private(rt, image):
    """This pins the *documented* default (POL-355, superseding POL-205) —
    not asserting it's desirable, just that it's what today's contract
    promises, so a future change is a deliberate decision this test forces
    someone to update."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        status, body = request_json("GET", f"/box/{b.id}")
        assert status == 200
        assert body.get("public") is False, (
            f"default box public field is {body.get('public')!r}, expected False "
            "per current documented default (POL-355)"
        )
    finally:
        await rt.remove(b.id, force=True)


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-311: the public REST contract (GET /v1/boxes/{id}) does not "
    "expose a `public` field at all — only the internal GET /box/{id} path does.",
)
async def test_public_field_visible_via_public_rest_api(rt, image):
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        status, body = request_json("GET", f"/v1/boxes/{b.id}")
        assert status == 200
        assert "public" in body, (
            f"GET /v1/boxes/{{id}} has no `public` field; keys={sorted(body.keys())}"
        )
    finally:
        await rt.remove(b.id, force=True)


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-311: SDK BoxInfo has no `public` attribute — fleet orchestration "
    "through the SDK cannot read box visibility at all.",
)
async def test_sdk_box_info_exposes_public(rt, image):
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        info = await rt.get_info(b.id)
        assert hasattr(info, "public"), (
            f"BoxInfo has no `public` attribute; attrs={[a for a in dir(info) if not a.startswith('_')]}"
        )
    finally:
        await rt.remove(b.id, force=True)
