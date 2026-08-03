"""E2E pin: the REST surface does NOT expose host bind mounts.

The cloud / managed runtime intentionally dropped host bind mounts
(see PR #639 "remove host bind mounts; only managed volumes
allowed"). Passing `volumes=[(host_path, guest_path, ...)]` to a
REST-mode `BoxOptions` must be a no-op at the runner — the
guest must never gain visibility of arbitrary host paths.

Day-1 RO semantics for *managed* volumes are covered separately;
the GHSA-g6ww-w5j2-r7x3 remount-RW attack and per-virtiofs RO
enforcement are in:
  - `sdks/python/tests/test_readonly_volume_remount.py` (FFI layer)
  - `src/boxlite/tests/mount_security.rs` (Rust)

This test pins the *negative* contract specific to the REST path:
host bind mounts are silently ignored, so no /mnt/<x> from the
host tree ever surfaces inside the guest.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_host_bind_mount_via_rest_is_silently_ignored(rt, image):
    """`BoxOptions(volumes=[(host_dir, "/mnt/ro", True)])` over REST
    must NOT result in /mnt/ro being mounted inside the guest. The
    REST API has no host-bind-mount surface (cf. PR #639); requests
    that include host paths get dropped at the mapper, the box
    starts cleanly, and the guest has no extra mount."""
    with tempfile.TemporaryDirectory(prefix="boxlite_e2e_ro_") as host_dir:
        os.chmod(host_dir, 0o755)
        marker_path = os.path.join(host_dir, "marker.txt")
        with open(marker_path, "w") as f:
            f.write("host-original\n")

        b = await rt.create(
            boxlite.BoxOptions(
                image=image,
                auto_remove=True,
                # Caller asks for a host bind mount — REST must drop this.
                volumes=[(host_dir, "/mnt/ro", True)],
            ),
        )
        try:
            # 1) /mnt/ro must NOT exist or must NOT be a mount point.
            ex = await b.exec(
                "sh",
                [
                    "-c",
                    # Print MOUNT_LINE=<row> if /mnt/ro shows up in
                    # /proc/mounts, otherwise MOUNT_LINE=<none>.
                    "row=\"$(grep ' /mnt/ro ' /proc/mounts || true)\"; "
                    "echo MOUNT_LINE=\"${row:-<none>}\"",
                ],
                None,
            )
            out, _ = await drain(ex)
            rc = await asyncio.wait_for(ex.wait(), timeout=30)
            assert rc.exit_code == 0, f"grep /proc/mounts failed: rc={rc.exit_code}"
            assert "MOUNT_LINE=<none>" in out, (
                f"REST should NOT honour host bind mounts, but the guest has a "
                f"mount at /mnt/ro: {out!r}"
            )

            # 2) Host file must not have been read or referenced by the
            # box — independent confirmation that no host path made it
            # through. Re-read host_dir contents and verify nothing
            # mutated.
            with open(marker_path, "r") as f:
                assert f.read() == "host-original\n", (
                    "host file mutated despite host bind mount not being wired"
                )
        finally:
            try:
                await rt.remove(b.id, force=True)
            except Exception:
                pass
