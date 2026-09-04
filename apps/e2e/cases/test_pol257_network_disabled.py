"""POL-257 257-11, POL-203/329/330 — fully disabled-network box creation.

Creating a box with network.outbound.mode="disabled" currently fails to
boot (400) instead of starting with no egress. Two follow-on defects ride
along with that failure:
  - the 400 body leaks internal VMM/shim diagnostics (POL-329)
  - the failed create still leaves an orphaned box row behind (POL-330)

Manually verified live against api.dev.boxlite.ai on 2026-08-24/25.
"""
from __future__ import annotations

import json

import pytest

from conftest import DEFAULT_IMAGE
from e2e_auth import request_json


def _create_disabled_network_box() -> tuple[int, dict]:
    return request_json(
        "POST", "/v1/boxes",
        {"image": DEFAULT_IMAGE, "network": {"outbound": {"mode": "disabled"}}},
    )


@pytest.fixture
def sweep_orphans():
    """Every test in this file triggers the disabled-network 400, which
    itself may leave an orphaned box row (POL-330) regardless of that
    individual test's own assertion outcome. Sweep and delete any box id
    that appeared during the test so failures here don't also leak
    billable resources."""
    _, before_body = request_json("GET", "/v1/boxes")
    before_ids = {b["box_id"] for b in before_body["boxes"]}
    yield
    _, after_body = request_json("GET", "/v1/boxes")
    after_ids = {b["box_id"] for b in after_body["boxes"]}
    for orphan_id in after_ids - before_ids:
        request_json("DELETE", f"/v1/boxes/{orphan_id}")


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-203: network.outbound.mode=disabled fails to boot (400, "
    "krun_start_enter dies with exit 159) instead of starting egress-less.",
)
async def test_disabled_network_box_boots(sweep_orphans):
    status, body = _create_disabled_network_box()
    assert status == 201, f"disabled-network create failed: {status} {body!r}"


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-329: the 400 error body for a failed disabled-network create "
    "leaks internal shim/krun diagnostics and host filesystem paths.",
)
async def test_disabled_network_failure_does_not_leak_internals(sweep_orphans):
    status, body = _create_disabled_network_box()
    assert status == 400
    body_str = json.dumps(body)
    for needle in ("/var/lib/boxlite", "shim.stderr", "krun_start_enter", "RUST_LOG=debug"):
        assert needle not in body_str, f"400 body leaked internal detail {needle!r}: {body_str!r}"


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-330: a failed (400) disabled-network create leaves an "
    "orphaned box row behind with status=unknown instead of no side effect.",
)
async def test_disabled_network_failure_leaves_no_orphan(sweep_orphans):
    _, before_body = request_json("GET", "/v1/boxes")
    before_ids = {b["box_id"] for b in before_body["boxes"]}

    status, body = _create_disabled_network_box()
    assert status == 400

    _, after_body = request_json("GET", "/v1/boxes")
    after_ids = {b["box_id"] for b in after_body["boxes"]}
    new_ids = after_ids - before_ids

    assert not new_ids, f"failed create left orphan box row(s): {new_ids}"
