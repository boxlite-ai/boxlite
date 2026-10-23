"""Box snapshots: a stopped box's disk, kept by the organization.

A snapshot is taken from a stopped box and restores into any stopped box of
the organization with the same disk size and region, whether its source box
still exists or not (openapi/box.openapi.yaml, `createSnapshot` and `restoreSnapshot`). The
cloud API runs both as runner jobs after it replies; the SDK polls each one to
its end, so the calls below return once the archive is written or the disk
swapped.

A stage without an archive bucket (BOX_SNAPSHOT_ARCHIVE_PREFIX unset, as on
AWS) reports `snapshots_enabled: false` from `/v1/config`, and the case skips.
"""
from __future__ import annotations

import asyncio
import uuid

import boxlite
import pytest

from conftest import drain
from e2e_auth import auth_context, request_json


# On the box's own disk, which is what a snapshot captures; the same path
# test_lifecycle_comprehensive.py proves survives a stop and start.
MARKER_PATH = "/workspace/snapshot-marker.txt"


def _snapshots_enabled() -> bool:
    status, body = request_json("GET", "/v1/config")
    assert status == 200, f"/v1/config returned {status}: {body}"
    return bool(((body or {}).get("capabilities") or {}).get("snapshots_enabled"))


async def _sh(box, script: str) -> str:
    ex = await box.exec("sh", ["-c", script])
    out, err = await drain(ex)
    result = await asyncio.wait_for(ex.wait(), timeout=30)
    assert result.exit_code == 0, f"{script!r} exited {result.exit_code}: {err!r}"
    return out


async def _wait_for_status(rt, box_id: str, expected: str) -> None:
    """Wait for a reported state: a stop or start call returns before it lands."""
    deadline = asyncio.get_running_loop().time() + 60
    while (status := (await rt.get_info(box_id)).state.status) != expected:
        assert asyncio.get_running_loop().time() < deadline, (
            f"box {box_id} never reached {expected}: {status}"
        )
        await asyncio.sleep(1)


async def _stop(rt, box) -> None:
    await box.stop()
    await _wait_for_status(rt, box.id, "stopped")


@pytest.mark.asyncio
@pytest.mark.timeout(600)
async def test_snapshot_outlives_its_box_and_restores_into_another(rt, image):
    """The disk a snapshot captured comes back in a different box, after the
    box it was taken from is gone: the snapshot belongs to the organization."""
    if not _snapshots_enabled():
        pytest.skip("this stage keeps no snapshots (snapshots_enabled: false)")

    ctx = auth_context()
    name = f"e2e-{uuid.uuid4().hex[:10]}"
    marker = f"captured-by-{name}"
    source = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    target = None
    try:
        await _sh(source, f"echo {marker} > {MARKER_PATH}")
        await _stop(rt, source)

        info = await source.snapshot.create(name=name)
        assert (info.name, info.box_id) == (name, source.id), f"unexpected snapshot: {info!r}"
        assert info.size_bytes > 0, f"a ready snapshot has an archive: {info!r}"

        await rt.remove(source.id, force=True)
        status, body = request_json("GET", ctx.v1(f"snapshots/{name}"))
        assert status == 200, f"snapshot did not outlive its box: {status} {body}"
        assert body.get("status") == "ready", f"snapshot is not ready: {body}"

        target = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
        # A fresh box of the same image: whatever the marker reads later can
        # only have come from the snapshot.
        absent = await _sh(target, f"test -e {MARKER_PATH} && echo present || echo absent")
        assert absent.strip() == "absent", f"target already had the marker: {absent!r}"
        await _stop(rt, target)

        await target.snapshot.restore(name)
        info = await rt.get_info(target.id)
        assert info.state.status == "stopped", f"restore left the box {info.state.status}"

        await target.start()
        await _wait_for_status(rt, target.id, "running")
        restored = await _sh(target, f"cat {MARKER_PATH}")
        assert restored.strip() == marker, f"restored disk lacks the snapshot's file: {restored!r}"
    finally:
        # Snapshots count against the organization's cap until removed; a
        # still-creating one refuses with 409 and is left for its job to end.
        request_json("DELETE", ctx.v1(f"snapshots/{name}"))
        for box in (source, target):
            if box is None:
                continue
            try:
                await rt.remove(box.id, force=True)
            except Exception:
                pass
