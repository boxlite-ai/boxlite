"""
Integration tests for snapshot COW child disk lifecycle.

Reproduces a bug where snapshot create() and restore() produce COW child
QCOW2 disks that are immediately deleted by Rust RAII (Disk::Drop),
because create_cow_child_disk() returns Disk with persistent=false
and the caller does not call .leak().

Bug location: boxlite/src/litebox/local_snapshot.rs
  - do_snapshot_create(): COW child disk deleted after move+create
  - do_snapshot_restore(): COW child disk deleted after restore+create

Compare with correct usage in:
  - container_rootfs.rs: temp_disk.leak()
  - clone_export.rs: ...create_cow_child_disk(...)?.leak()

Note: SyncBox does not expose the snapshot property, so snapshot operations
are bridged through shared_sync_runtime._sync() on the underlying async
Box (box._box.snapshot).  All other operations use the normal sync API.
"""

from __future__ import annotations

from pathlib import Path

import boxlite
import pytest

pytestmark = pytest.mark.integration

BOXLITE_HOME = Path.home() / ".boxlite"
IMAGE = "alpine:latest"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def box_disk_path(box_id: str, filename: str) -> Path:
    """Return the expected path of a disk file in a box directory."""
    return BOXLITE_HOME / "boxes" / box_id / filename


def snapshot_disk_path(box_id: str, snap_name: str, filename: str) -> Path:
    """Return the expected path of a snapshot disk file."""
    return BOXLITE_HOME / "boxes" / box_id / "snapshots" / snap_name / filename


class SnapshotHarness:
    """Utility wrapper for snapshot operations on a SyncBox.

    SyncBox does not expose the snapshot property, so this harness bridges
    snapshot calls through the sync runtime's greenlet machinery using the
    underlying async Box object.
    """

    def __init__(self, sync_runtime) -> None:
        self._runtime = sync_runtime
        self._boxes: list = []

    def create_box(self, *, image: str = IMAGE, name: str | None = None):
        """Create a started box with auto_remove=False."""
        opts = boxlite.BoxOptions(image=image, auto_remove=False)
        box = self._runtime.create(opts, name=name)
        self._boxes.append(box)
        return box

    def exec_output(self, box, cmd: str, *args: str) -> str:
        """Run a command and return stripped stdout."""
        execution = box.exec(cmd, list(args) if args else None)
        lines = list(execution.stdout())
        execution.wait()
        return "".join(lines).strip()

    def snap_create(self, box, name: str):
        """Create a snapshot (async bridge)."""
        return self._runtime._sync(box._box.snapshot.create(name=name))

    def snap_list(self, box):
        """List snapshots (async bridge)."""
        return self._runtime._sync(box._box.snapshot.list())

    def snap_restore(self, box, name: str):
        """Restore a snapshot (async bridge)."""
        return self._runtime._sync(box._box.snapshot.restore(name))

    def reacquire(self, box_id: str):
        """Re-acquire a SyncBox handle by ID."""
        box = self._runtime.get(box_id)
        self._boxes.append(box)
        return box

    def cleanup(self) -> None:
        """Stop and remove all boxes."""
        for box in list(self._boxes):
            try:
                box.stop()
            except Exception:
                pass
            try:
                self._runtime.remove(box.id, force=True)
            except Exception:
                pass


@pytest.fixture
def harness(shared_sync_runtime):
    """Per-test snapshot harness wrapping the shared sync runtime."""
    h = SnapshotHarness(shared_sync_runtime)
    try:
        yield h
    finally:
        h.cleanup()


# ---------------------------------------------------------------------------
# Tests — snapshot create
# ---------------------------------------------------------------------------


class TestSnapshotCreateDiskIntegrity:
    """Verify that snapshot create() preserves a bootable box."""

    def test_cow_child_disks_exist_after_create(self, harness):
        """COW child disks must exist in the box directory after create().

        Bug: create_cow_child_disk() returns Disk(persistent=false) and the
        Disk goes out of scope, so Drop deletes the newly created file.
        """
        box = harness.create_box()
        harness.exec_output(box, "echo", "ready")
        box_id = box.id

        # Precondition: disks exist before snapshot
        assert box_disk_path(box_id, "disk.qcow2").exists()
        assert box_disk_path(box_id, "guest-rootfs.qcow2").exists()

        box.stop()
        info = harness.snap_create(box, "ckpt1")
        assert info.name == "ckpt1"

        # Snapshot copies should exist
        assert snapshot_disk_path(box_id, "ckpt1", "disk.qcow2").exists()
        assert snapshot_disk_path(box_id, "ckpt1", "guest-rootfs.qcow2").exists()

        # BUG CHECK: COW child disks in the box root must ALSO still exist
        assert box_disk_path(box_id, "disk.qcow2").exists(), (
            "COW child disk.qcow2 missing after create — "
            "Disk::Drop deleted it (missing .leak() in local_snapshot.rs)"
        )
        assert box_disk_path(box_id, "guest-rootfs.qcow2").exists(), (
            "COW child guest-rootfs.qcow2 missing after create — "
            "Disk::Drop deleted it (missing .leak() in local_snapshot.rs)"
        )

    def test_box_restartable_after_snapshot_create(self, harness):
        """Box must be restartable after snapshot create().

        Fails if COW child disks were deleted by Disk::Drop.
        """
        box = harness.create_box()
        harness.exec_output(box, "sh", "-c", "echo BEFORE > /root/v.txt")
        box_id = box.id

        box.stop()
        harness.snap_create(box, "restart_test")

        box2 = harness.reacquire(box_id)
        box2.start()

        out = harness.exec_output(box2, "cat", "/root/v.txt")
        assert out == "BEFORE", f"Expected 'BEFORE', got '{out}'"
        box2.stop()


# ---------------------------------------------------------------------------
# Tests — snapshot restore
# ---------------------------------------------------------------------------


class TestSnapshotRestoreDiskIntegrity:
    """Verify that snapshot restore() produces a bootable box."""

    def test_cow_child_disks_exist_after_restore(self, harness):
        """COW child disks must exist in the box directory after restore().

        Flow: stop -> create -> restore -> check disks.
        No intermediate restart so this isolates the restore path.
        """
        box = harness.create_box()
        harness.exec_output(box, "sh", "-c", "echo V1 > /root/state.txt")
        box_id = box.id

        box.stop()
        harness.snap_create(box, "v1_snap")

        snapshots = harness.snap_list(box)
        assert any(s.name == "v1_snap" for s in snapshots)

        harness.snap_restore(box, "v1_snap")

        # BUG CHECK
        assert box_disk_path(box_id, "disk.qcow2").exists(), (
            "COW child disk.qcow2 missing after restore — "
            "Disk::Drop deleted it (missing .leak() in local_snapshot.rs)"
        )
        assert box_disk_path(box_id, "guest-rootfs.qcow2").exists(), (
            "COW child guest-rootfs.qcow2 missing after restore — "
            "Disk::Drop deleted it (missing .leak() in local_snapshot.rs)"
        )

    def test_box_startable_after_restore(self, harness):
        """Box must be startable after snapshot restore().

        Flow: stop -> create -> restore -> start.
        """
        box = harness.create_box()
        harness.exec_output(box, "sh", "-c", "echo RESTORE_V1 > /root/ver.txt")
        box_id = box.id

        box.stop()
        harness.snap_create(box, "restore_boot_test")
        harness.snap_restore(box, "restore_boot_test")

        box2 = harness.reacquire(box_id)
        box2.start()

        out = harness.exec_output(box2, "cat", "/root/ver.txt")
        assert out == "RESTORE_V1", f"Expected 'RESTORE_V1', got '{out}'"
        box2.stop()


# ---------------------------------------------------------------------------
# Tests — snapshot metadata persistence
# ---------------------------------------------------------------------------


class TestSnapshotListPersistence:
    """Verify snapshot metadata survives box lifecycle with auto_remove=False."""

    def test_snapshots_persist_after_stop(self, harness):
        """Snapshots created with auto_remove=False must be listed after stop."""
        box = harness.create_box()
        harness.exec_output(box, "echo", "ready")

        box.stop()
        harness.snap_create(box, "persist_test")

        snapshots = harness.snap_list(box)
        names = {s.name for s in snapshots}
        assert "persist_test" in names, (
            "Snapshot metadata lost after stop() with auto_remove=False"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
