"""Outbound network policy over REST.

Ported from E2B's cloud network test
`packages/python-sdk/tests/async/sandbox_async/test_internet_access.py`, which
asserts a sandbox's reach to the internet is what the create call asked for —
:7-16 curls an external host with access enabled, :20-30 expects the same curl
to fail with it disabled. BoxLite says it with
`NetworkSpec(outbound=OutboundNetworkSpec(mode=..., allow_net=[...]))`, which
the API turns into the runner's `outboundEnabled` / `outboundAllowNet`
(apps/api/src/boxlite-rest/mappers/box-to-box.mapper.ts:79-81,
apps/runner/pkg/api/dto/box.go:31).

`test_box_management.py` covers the inbound half (preview reachability). The
outbound half had no cloud coverage, and a silently-unenforced policy is the
failure that matters: the caller believes the box is sealed and it is not.

Each test pairs the two directions in one run — a permitted box as the control
and a restricted box as the treatment. Without the control, a guest whose
network is simply broken would make "blocked" look like enforcement.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import boxlite
import pytest

from conftest import drain


REACHABLE_URL = os.environ.get("BOXLITE_E2E_EGRESS_ALLOWED_URL", "https://httpbingo.org/")
UNLISTED_URL = os.environ.get("BOXLITE_E2E_EGRESS_UNLISTED_URL", "https://example.com/")
REACHABLE_HOST = urlsplit(REACHABLE_URL).hostname
UNLISTED_HOST = urlsplit(UNLISTED_URL).hostname
PROBE = (Path(__file__).parents[1] / "fixtures/egress_probe.py").read_text()


async def _reaches(box, host: str) -> bool:
    url = host if "://" in host else f"https://{host}/"
    target = urlsplit(url)
    assert target.scheme in ("http", "https") and target.hostname
    assert not target.username and not target.password, "probe URL must not contain credentials"
    ex = await box.exec("python3", ["-c", PROBE, url], None)
    out, _ = await asyncio.wait_for(drain(ex), timeout=20)
    result = await asyncio.wait_for(ex.wait(), timeout=20)
    assert out.strip(), "egress probe returned no completion record"
    try:
        record = json.loads(out)
    except ValueError:
        raise AssertionError("egress probe returned an invalid completion record") from None
    assert isinstance(record, dict) and record.get("probe") == "boxlite-egress-v1"
    assert result.exit_code == 0, f"egress probe failed: {record.get('error_type')} / {record.get('error_reason')}"
    assert type(record.get("reachable")) is bool, "egress probe omitted its result"
    return record["reachable"]


@pytest.mark.asyncio
async def test_outbound_disabled_seals_the_box(rt, image):
    enabled = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled"))
    disabled = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="disabled"))

    control = await rt.create(boxlite.BoxOptions(image=image, network=enabled))
    try:
        assert await _reaches(control, REACHABLE_URL), "unrestricted control cannot reach the probe"
    finally:
        await rt.remove(control.id, force=True)

    sealed = await rt.create(boxlite.BoxOptions(image=image, network=disabled))
    try:
        assert not await _reaches(sealed, REACHABLE_URL), (
            f"outbound=disabled box still reached {REACHABLE_HOST}"
        )
    finally:
        await rt.remove(sealed.id, force=True)


@pytest.mark.asyncio
async def test_allow_net_admits_only_the_listed_host(rt, image):
    """An allow-list admits its host and nothing else.

    Both hosts must be reachable from an unrestricted control. A broken
    baseline fails the run before a restricted request can count as blocked.
    """
    control = await rt.create(
        boxlite.BoxOptions(
            image=image,
            network=boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled")),
        ),
    )
    try:
        assert REACHABLE_HOST != UNLISTED_HOST, "allowlist probes need distinct hosts"
        for url in (REACHABLE_URL, UNLISTED_URL):
            assert await _reaches(control, url), "unrestricted control cannot reach both probes"
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
        assert await _reaches(box, REACHABLE_URL), (
            f"allow_net=[{REACHABLE_HOST}] blocked the host it names"
        )
        assert not await _reaches(box, UNLISTED_URL), (
            f"allow_net=[{REACHABLE_HOST}] still let the box reach {UNLISTED_HOST}"
        )
    finally:
        await rt.remove(box.id, force=True)
