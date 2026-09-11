"""E2E: managed-volume CRUD and mounting a volume into a box.

No prior test in this suite covers the managed-volume surface end to
end — `test_volume_readonly.py` only pins the negative contract (host
bind mounts are ignored over REST). This file exercises the actual
lifecycle: create → list → get → mount into a box → write/read data
through the mount → remount into a second box to prove persistence →
remove.

`rt.volumes` maps to `RestRuntime`'s `VolumeBackend` impl
(`src/boxlite/src/rest/runtime.rs`), which calls `POST/GET/DELETE
/volumes`. Mounting goes through `BoxOptions(volumes=[(id, guest_path)])`
→ `VolumeSpec.host_path` → `managed_volume_source()` (`src/boxlite/src/
rest/types.rs`), which prepends the `volume://` scheme for a bare id
before it reaches the REST create-box request.

All three cases pass against dev as of 2026-08-13. An earlier run of
this file reported `test_volume_mounts_and_persists_data_across_boxes`
failing (no mount, `guest_path` never created) — that was a false
positive from testing against a stale local Python SDK build (the
compiled extension was ~8 days out of date). Rebuilding via `make
dev:python` and re-running against dev confirmed the mount path works
end to end; no code change was needed.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import boxlite
import pytest
from conftest import drain


@pytest.mark.asyncio
async def test_volume_crud_lifecycle(rt):
    """Create, list, get, and remove a managed volume via the REST
    volume handle.

    Removal is a soft delete, reconciled asynchronously: `DELETE
    /volumes/{id}` returns 204, but confirmed directly against dev, a
    `GET` immediately after still resolves 200 with `state:
    "pending_delete"`, and `list()` can still include it for a short
    window afterward too (the VolumeManager reconciler moves it out of
    `pending_delete` on its own poll cycle, not synchronously with the
    DELETE response). So neither "get() raises" nor "list() excludes
    it immediately" is a guarantee — poll list() with a bounded
    timeout instead.
    """
    info = await rt.volumes.create()
    assert info.id

    listed = await rt.volumes.list()
    assert any(v.id == info.id for v in listed), (
        f"created volume {info.id} missing from list(): {[v.id for v in listed]}"
    )

    fetched = await rt.volumes.get(info.id)
    assert fetched.id == info.id

    await rt.volumes.remove(info.id, force=True)

    deadline = time.monotonic() + 15.0
    listed_after = await rt.volumes.list()
    while any(v.id == info.id for v in listed_after) and time.monotonic() < deadline:
        await asyncio.sleep(1)
        listed_after = await rt.volumes.list()

    assert not any(v.id == info.id for v in listed_after), (
        f"removed volume {info.id} still present in list() after 15s: "
        f"{[v.id for v in listed_after]}"
    )


@pytest.mark.asyncio
async def test_volume_mounts_and_persists_data_across_boxes(rt, image):
    """A managed volume mounted into one box, written to, then mounted
    into a second box must show the same data — proving the mount is
    backed by real persistent (S3) storage, not the box's own
    ephemeral disk."""
    info = await rt.volumes.create()
    volume_id = info.id
    marker = f"e2e-{uuid.uuid4().hex[:12]}"

    try:
        writer = await rt.create(
            boxlite.BoxOptions(
                image=image,
                auto_remove=True,
                volumes=[(volume_id, "/data")],
            ),
        )
        try:
            ex = await writer.exec(
                "sh", ["-c", f"echo {marker} > /data/marker.txt"], None
            )
            out, err = await drain(ex)
            rc = await asyncio.wait_for(ex.wait(), timeout=30)
            assert rc.exit_code == 0, (
                f"write into mounted volume failed: rc={rc.exit_code} out={out!r} err={err!r}"
            )
        finally:
            await rt.remove(writer.id, force=True)

        reader = await rt.create(
            boxlite.BoxOptions(
                image=image,
                auto_remove=True,
                volumes=[(volume_id, "/data")],
            ),
        )
        try:
            ex = await reader.exec("cat", ["/data/marker.txt"], None)
            out, err = await drain(ex)
            rc = await asyncio.wait_for(ex.wait(), timeout=30)
            assert rc.exit_code == 0, (
                f"read from remounted volume failed: rc={rc.exit_code} err={err!r}"
            )
            assert marker in out, (
                f"data written by the first box did not survive remount into "
                f"the second: expected {marker!r} in {out!r}"
            )
        finally:
            await rt.remove(reader.id, force=True)
    finally:
        await rt.volumes.remove(volume_id, force=True)


@pytest.mark.asyncio
async def test_volume_remove_while_mounted_is_rejected_or_deferred(rt, image):
    """Removing a volume that's still referenced by a live box must not
    silently corrupt the box's mount — either the API rejects the
    remove (still-in-use) or accepts it without crashing the box.
    Guards against a 5xx / dangling-reference regression, not a single
    fixed status code."""
    info = await rt.volumes.create()
    volume_id = info.id

    box = await rt.create(
        boxlite.BoxOptions(
            image=image, auto_remove=True, volumes=[(volume_id, "/data")]
        ),
    )
    try:
        try:
            await rt.volumes.remove(volume_id, force=False)
        except Exception as e:
            msg = str(e)
            assert "500" not in msg and "Internal" not in msg, (
                f"remove-while-mounted leaked a 5xx instead of a typed conflict: {msg!r}"
            )
        # Whether or not the remove was accepted, the box itself must
        # still be usable — no half-torn-down state.
        ex = await box.exec("echo", ["still-alive"], None)
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0 and "still-alive" in out
    finally:
        await rt.remove(box.id, force=True)
        try:
            await rt.volumes.remove(volume_id, force=True)
        except Exception:
            pass
