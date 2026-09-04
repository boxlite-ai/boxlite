"""POL-257 257-14 — internal/admin surfaces must fail closed consistently.

`/regions` and `/runners` are gated by the same ORGANIZATION_INFRASTRUCTURE
feature flag (apps/api/src/organization/controllers/organization-region.controller.ts,
apps/api/src/box/controllers/runner.controller.ts). With the flag off,
`/runners` correctly returns 403; `/regions` returns 500 because its list
endpoint is missing the @RequireFlagsEnabled guard the other endpoints have.

Manually verified live against api.dev.boxlite.ai on 2026-08-24 (POL-331).
"""
from __future__ import annotations

import pytest

from e2e_auth import request_json


@pytest.mark.asyncio
async def test_admin_box_endpoints_are_not_exposed():
    for path in ("/admin/box", "/admin/box/list"):
        status, _ = request_json("GET", path)
        assert status == 404, f"{path} returned {status}, expected 404 (not exposed)"


@pytest.mark.asyncio
async def test_box_for_runner_requires_runner_auth():
    status, _ = request_json("GET", "/box/for-runner")
    assert status == 401, f"/box/for-runner returned {status}, expected 401"


@pytest.mark.asyncio
async def test_runners_fails_closed_when_flag_disabled():
    status, _ = request_json("GET", "/runners")
    assert status == 403, f"/runners returned {status}, expected 403 (fail closed)"


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-331: GET /regions is missing @RequireFlagsEnabled on "
    "OrganizationRegionController.list() (organization-region.controller.ts), "
    "so it 500s instead of fail-closing to 403 like /runners does.",
)
async def test_regions_fails_closed_consistently_with_runners():
    status, _ = request_json("GET", "/regions")
    assert status == 403, f"/regions returned {status}, expected 403 (fail closed, matching /runners)"


@pytest.mark.asyncio
async def test_regions_500_does_not_leak_stack_trace():
    """Even while POL-331 is open, the 500 body itself must stay clean —
    this is the one property that must not regress alongside the fix."""
    status, body = request_json("GET", "/regions")
    body_str = str(body)
    assert "at " not in body_str or "stack" not in body_str.lower(), (
        f"/regions 500 leaked what looks like a stack trace: {body_str!r}"
    )
    for needle in ("/var/lib/boxlite", ".ts:", ".rs:", "node_modules"):
        assert needle not in body_str, f"/regions 500 leaked internal path/ref: {body_str!r}"
