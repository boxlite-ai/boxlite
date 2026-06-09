"""E2E port of `src/boxlite/tests/snapshot.rs` + `clone_export_import.rs`.

Verifies the snapshot / clone / export / import chain through the REST
runtime. The Rust FFI suite has ~67 sub-cases across these files; we
mirror only the round-trips that prove disk content actually crosses
the SDK → API → Runner → VM boundary intact:

  - snapshot.create produces an id that snapshot.list reports
  - snapshot.restore re-materializes earlier guest disk state
  - clone_box yields an independent disk (write to clone doesn't leak
    to the parent)
  - export → import round-trip preserves a guest-side file

Anything covered by FFI alone (snapshot metadata fields, options
parsing, error variants) stays in the FFI suite — re-running it here
just burns VMs.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import boxlite
import pytest

from conftest import drain


async def _put_file(b, path: str, content: str) -> None:
    ex = await b.exec("sh", ["-c", f"mkdir -p $(dirname {path}) && printf %s {content!r} > {path}"], None)
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"seed write failed: rc={rc.exit_code}"


async def _read_file(b, path: str) -> tuple[int, str]:
    ex = await b.exec("cat", [path], None)
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    return rc.exit_code, out


@pytest.mark.asyncio
async def test_snapshot_create_appears_in_list(rt, image):
    """A box snapshot's name shows up in snapshot.list() right away.
    This is the smallest hop in the snapshot REST path — if the create
    call silently no-ops, list will catch it."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        await b.stop()  # snapshots typically require a quiesced box
        snap = await b.snapshot.create(name="e2e-snap-1")
        assert snap is not None and snap.name == "e2e-snap-1", (
            f"snapshot.create returned wrong shape: {snap}"
        )
        listed = await b.snapshot.list()
        names = {s.name for s in listed}
        assert "e2e-snap-1" in names, (
            f"snapshot.list missed created snapshot: {names}"
        )
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_snapshot_restore_reverts_disk(rt, image):
    """Write content A, snapshot, write content B, restore: disk reads
    A again. This is the disk-roundtrip contract — any silent
    serialization bug in the snapshot REST path drops bytes here."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        await _put_file(b, "/var/state", "before-snapshot")
        await b.stop()
        await b.snapshot.create(name="e2e-restore")
        await b.start()
        await _put_file(b, "/var/state", "after-snapshot")
        rc, out = await _read_file(b, "/var/state")
        assert rc == 0 and out == "after-snapshot", (
            f"sanity: pre-restore state wrong: rc={rc} out={out!r}"
        )

        await b.stop()
        await b.snapshot.restore("e2e-restore")
        await b.start()
        rc, out = await _read_file(b, "/var/state")
        assert rc == 0, f"read after restore failed: rc={rc}"
        assert out == "before-snapshot", (
            f"snapshot.restore did not revert disk: got {out!r}"
        )
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_clone_box_yields_independent_disk(rt, image):
    """Clone the box, then write to the clone. The original's disk
    must not see the write — proves clone made a copy, not a shared
    reference."""
    parent = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    clone = None
    try:
        await _put_file(parent, "/var/shared", "from-parent")
        await parent.stop()
        clone = await parent.clone_box(name=None)
        await parent.start()
        await clone.start()

        # Mutate the clone, not the parent.
        await _put_file(clone, "/var/shared", "from-clone")

        rc_p, out_p = await _read_file(parent, "/var/shared")
        rc_c, out_c = await _read_file(clone, "/var/shared")
        assert rc_p == 0 and rc_c == 0
        assert out_p == "from-parent", (
            f"clone write leaked to parent: parent now {out_p!r}"
        )
        assert out_c == "from-clone", (
            f"clone disk write didn't stick: clone shows {out_c!r}"
        )
    finally:
        for box_handle in (clone, parent):
            if box_handle is None:
                continue
            try:
                await rt.remove(box_handle.id, force=True)
            except Exception:
                pass


@pytest.mark.asyncio
async def test_export_import_roundtrip(rt, image):
    """Export a box to a `.boxlite` archive, import it as a new box,
    and confirm guest-side state crossed the archive boundary."""
    src = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    imported = None
    archive_path = None
    try:
        marker = "e2e-export-marker-" + os.urandom(4).hex()
        await _put_file(src, "/var/marker", marker)
        await src.stop()

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = str(Path(tmpdir) / "box.boxlite")
            archive_path = await src.export(dest=dest)
            assert archive_path and os.path.exists(archive_path), (
                f"export returned {archive_path!r} but file is missing"
            )

            imported = await rt.import_box(archive_path, name=None)
            await imported.start()
            rc, out = await _read_file(imported, "/var/marker")
        assert rc == 0, f"read after import failed: rc={rc}"
        assert out == marker, (
            f"export/import lost marker: expected {marker!r}, got {out!r}"
        )
    finally:
        for box_handle in (imported, src):
            if box_handle is None:
                continue
            try:
                await rt.remove(box_handle.id, force=True)
            except Exception:
                pass
