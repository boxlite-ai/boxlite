"""Outbound network policy over REST.

Ported from E2B's cloud network test
`packages/python-sdk/tests/async/sandbox_async/test_internet_access.py`, which
asserts a sandbox's reach to the internet is what the create call asked for —
:7-16 curls an external host with access enabled, :20-30 expects the same curl
to fail with it disabled. BoxLite says it with
`NetworkSpec(outbound=OutboundNetworkSpec(mode=..., allow_net=[...]))`, which
the API turns into the runner's `networkBlockAll` / `networkAllowList`
(apps/api/src/boxlite-rest/mappers/box-to-box.mapper.ts:73-77,
apps/runner/pkg/api/dto/box.go:29).

`test_box_management.py` covers the inbound half (preview reachability). The
outbound half had no cloud coverage, and a silently-unenforced policy is the
failure that matters: the caller believes the box is sealed and it is not.

Each test pairs the two directions in one run — a permitted box as the control
and a restricted box as the treatment. Without the control, a guest whose
network is simply broken would make "blocked" look like enforcement.
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


REACHABLE_HOST = "httpbingo.org"
UNLISTED_HOST = "example.com"


def _probe(host: str) -> str:
    # curl first, wget as the fallback — same shape as test_real_world.py:233,
    # because the base image is not guaranteed to carry both.
    return (
        f"curl -fsS --max-time 10 -o /dev/null https://{host}/ 2>/dev/null && echo REACHED || "
        f"wget -q --timeout=10 -O /dev/null https://{host}/ 2>/dev/null && echo REACHED || "
        "echo BLOCKED"
    )


async def _reaches(box, host: str) -> bool:
    ex = await box.exec("sh", ["-c", _probe(host)], None)
    out, _ = await drain(ex)
    await asyncio.wait_for(ex.wait(), timeout=60)
    return "REACHED" in out


@pytest.mark.asyncio
async def test_outbound_disabled_seals_the_box(rt, image):
    enabled = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled"))
    disabled = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="disabled"))

    control = await rt.create(boxlite.BoxOptions(image=image, network=enabled))
    try:
        if not await _reaches(control, REACHABLE_HOST):
            pytest.skip(f"stage cannot reach {REACHABLE_HOST} even with outbound enabled")
    finally:
        await rt.remove(control.id, force=True)

    sealed = await rt.create(boxlite.BoxOptions(image=image, network=disabled))
    try:
        assert not await _reaches(sealed, REACHABLE_HOST), (
            f"outbound=disabled box still reached {REACHABLE_HOST}"
        )
    finally:
        await rt.remove(sealed.id, force=True)


@pytest.mark.asyncio
async def test_allow_net_admits_only_the_listed_host(rt, image):
    """An allow-list admits its host and nothing else.

    The control box carries no allow-list, so it answers the question the
    skip needs answered — can this stage reach the host at all — without the
    policy under test in the way. Skipping on the allow-listed box instead
    would turn a deny-everything regression into a silent skip.
    """
    control = await rt.create(
        boxlite.BoxOptions(
            image=image,
            network=boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled")),
        ),
    )
    try:
        if not await _reaches(control, REACHABLE_HOST):
            pytest.skip(f"stage cannot reach {REACHABLE_HOST} even with outbound enabled")
    finally:
        await rt.remove(control.id, force=True)

    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            network=boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(
                    mode="enabled", allow_net=[REACHABLE_HOST],
                ),
            ),
        ),
    )
    try:
        assert await _reaches(box, REACHABLE_HOST), (
            f"allow_net=[{REACHABLE_HOST}] blocked the host it names"
        )
        assert not await _reaches(box, UNLISTED_HOST), (
            f"allow_net=[{REACHABLE_HOST}] still let the box reach {UNLISTED_HOST}"
        )
    finally:
        await rt.remove(box.id, force=True)
