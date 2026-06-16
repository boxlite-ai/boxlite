"""Per-box + per-org quota enforcement at the API boundary.

The admin org's per-box quotas are set by `fixture_setup.py::patch_admin_quota`:

  max_cpu_per_box    = 4
  max_memory_per_box = 8 (GiB)
  max_disk_per_box   = 20 (GiB)

Plus the bootstrap's `ADMIN_TOTAL_*_QUOTA` envelope (32 CPU, 64 GiB mem,
200 GiB disk org-wide).

Quota violations must surface as 429 ResourceExhausted (or 400 if the API
treats it as a validation error). 500 means the runner accepted a doomed
job and crashed it later; that's the bug class this case covers.

ALL cases in this file currently XFAIL — see module-level pytestmark.
"""

# Production bug pinned by every case in this file: API silently clamps
# out-of-range / over-quota resource values to org defaults instead of
# rejecting at the boundary. Root cause at
# apps/api/src/boxlite-rest/dto/create-box.dto.ts:24 (@Min present, no @Max,
# no quota lookup) + apps/api/src/box/services/box.service.ts
# (createFromSnapshot doesn't consult max_*_per_box columns even though
# fixture_setup.py:107-126 sets them).
#
# Two-sided requires API-side fix; tests pin the bug, NOT the test code.

from __future__ import annotations

import json
from typing import Any

import pytest

from e2e_auth import auth_context, request_json

pytestmark = pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: API silently clamps out-of-range / over-quota "
        "resource values to org defaults instead of returning 400/429. See "
        "module docstring for full root cause."
    ),
)


def _post_box(spec: dict) -> tuple[int, dict[str, Any] | None]:
    return request_json("POST", auth_context().v1("boxes"), spec)


def _delete_box(box_id: str) -> None:
    try:
        request_json("DELETE", auth_context().v1(f"boxes/{box_id}"))
    except Exception:
        pass


@pytest.mark.asyncio
async def test_cpus_above_per_box_limit_returns_4xx():
    """cpus far above max_cpu_per_box (4) → 429 or 400, not 5xx."""
    status, body = _post_box(
        {"image": "alpine:3.23", "cpus": 999, "memory_mib": 256, "disk_size_gb": 4}
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"cpus=999 leaked HTTP {status}: {body_str}"


@pytest.mark.asyncio
async def test_memory_above_per_box_limit_returns_4xx():
    """memory far above max_memory_per_box (8 GiB) → 4xx, not 5xx."""
    status, body = _post_box(
        {
            "image": "alpine:3.23",
            "cpus": 1,
            "memory_mib": 8_192_000_000,
            "disk_size_gb": 4,
        }
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"memory=99999 leaked HTTP {status}: {body_str}"


@pytest.mark.asyncio
async def test_disk_above_per_box_limit_returns_4xx():
    """disk far above max_disk_per_box (20 GiB) → 4xx, not 5xx."""
    status, body = _post_box(
        {
            "image": "alpine:3.23",
            "cpus": 1,
            "memory_mib": 256,
            "disk_size_gb": 99_999_999,
        }
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"disk=99999999 leaked HTTP {status}: {body_str}"


@pytest.mark.asyncio
async def test_quota_violation_does_not_silently_create_box(rt):
    """A 4xx quota response must NOT have created a box. If we list
    immediately and find an orphan with cpus=999, the runner accepted the
    doomed request and the quota check is decorative."""
    status, body = _post_box(
        {"image": "alpine:3.23", "cpus": 999, "memory_mib": 256, "disk_size_gb": 4}
    )
    if 200 <= status < 300:
        pytest.fail(f"cpus=999 unexpectedly succeeded: HTTP {status}, body={body}")

    # If a box id was returned in the error body (e.g. partial-create + rollback
    # leak), surface it and ensure it doesn't actually exist.
    body_str = json.dumps(body) if body else ""
    if body and isinstance(body, dict) and "id" in body:
        leaked_id = body["id"]
        _delete_box(leaked_id)
        pytest.fail(f"quota-rejected POST leaked a box id in response: {leaked_id}")
    assert "999" not in body_str or "cpu" in body_str.lower(), (
        f"error body doesn't explain the quota miss: {body_str}"
    )


@pytest.mark.asyncio
async def test_quota_zero_cpus_returns_4xx():
    """cpus=0 — boundary at the other end. Must be 4xx, not 500 or a box
    that immediately crashes."""
    status, body = _post_box(
        {"image": "alpine:3.23", "cpus": 0, "memory_mib": 256, "disk_size_gb": 4}
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"cpus=0 leaked HTTP {status}: {body_str}"
