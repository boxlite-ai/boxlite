"""Disk I/O rate limits (`disk_io`) across the REST boundary.

The limits are enforced runner-side through the box's cgroup, so from the API
the observable contract is: a well-formed `disk_io` is accepted and the box
still comes up (201, not 5xx), and a zero ceiling — which io.max cannot
express and the runtime rejects — is refused at the boundary as a 4xx rather
than accepted and crashed later on the runner.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from conftest import DEFAULT_IMAGE
from e2e_auth import auth_context, request_json


def _post_box(spec: dict) -> tuple[int, dict[str, Any] | None]:
    return request_json("POST", auth_context().v1("boxes"), spec)


def _delete_box(box_id: str) -> None:
    try:
        request_json("DELETE", auth_context().v1(f"boxes/{box_id}"))
    except Exception:
        pass


@pytest.mark.asyncio
async def test_disk_io_limits_are_accepted():
    """A partial disk_io (write bandwidth + read IOPS) creates a box normally."""
    status, body = _post_box(
        {
            "image": DEFAULT_IMAGE,
            "cpus": 1,
            "memory_mib": 256,
            "disk_size_gb": 4,
            "disk_io": {"write_bps": 4 * 1024 * 1024, "read_iops": 500},
        }
    )
    body_str = json.dumps(body) if body else ""
    assert status == 201, f"disk_io create returned HTTP {status}: {body_str}"
    assert body is not None
    _delete_box(body["box_id"])


@pytest.mark.asyncio
async def test_zero_disk_io_ceiling_returns_4xx():
    """disk_io.read_bps=0 is a caller mistake → 400, never a 5xx from the runner."""
    status, body = _post_box(
        {
            "image": DEFAULT_IMAGE,
            "cpus": 1,
            "memory_mib": 256,
            "disk_size_gb": 4,
            "disk_io": {"read_bps": 0},
        }
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"disk_io.read_bps=0 leaked HTTP {status}: {body_str}"
    if body and "box_id" in body:
        _delete_box(body["box_id"])


@pytest.mark.asyncio
async def test_unknown_disk_io_field_returns_4xx():
    """Nested whitelisting: an unknown key inside disk_io is refused like one in network."""
    status, body = _post_box(
        {
            "image": DEFAULT_IMAGE,
            "cpus": 1,
            "memory_mib": 256,
            "disk_size_gb": 4,
            "disk_io": {"bogus": 1},
        }
    )
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, f"disk_io.bogus leaked HTTP {status}: {body_str}"
    if body and "box_id" in body:
        _delete_box(body["box_id"])
