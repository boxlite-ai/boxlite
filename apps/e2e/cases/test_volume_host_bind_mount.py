"""E2E pin: the REST surface does NOT accept host bind mounts.

The cloud / managed runtime intentionally dropped host bind mounts
(see PR #639 "remove host bind mounts; only managed volumes
allowed"). A REST-mode `BoxOptions` carrying `volumes=[(host_path,
guest_path, ...)]` must not produce a box with that host path
mounted.

The rejection is explicit, not silent. Managed volumes (#1192) made
`volumes[].source` a `volume://<id>` reference and the mapper now
400s anything else, rather than dropping it on the floor. Failing
loud is the contract worth pinning: a silently ignored bind mount
leaves the caller believing the guest can see a host directory it
cannot.

Day-1 RO semantics for *managed* volumes are covered separately;
the GHSA-g6ww-w5j2-r7x3 remount-RW attack and per-virtiofs RO
enforcement are in:
  - `sdks/python/tests/test_readonly_volume_remount.py` (FFI layer)
  - `src/boxlite/tests/mount_security.rs` (Rust)
"""

from __future__ import annotations

import tempfile

import boxlite
import pytest


@pytest.mark.asyncio
async def test_host_bind_mount_via_rest_is_rejected(rt, image):
    """`BoxOptions(volumes=[(host_dir, "/mnt/ro")])` over REST must be
    rejected at the request boundary. The Python SDK sends a bare host
    path as `volumes[].host_path`; the mapper requires a `volume://`
    managed-volume reference, so the box is never created and no host
    path can reach the guest."""
    with tempfile.TemporaryDirectory(prefix="boxlite_e2e_hostmount_") as host_dir:
        with pytest.raises(Exception, match="volume") as exc_info:
            await rt.create(
                boxlite.BoxOptions(
                    image=image,
                    auto_remove=True,
                    # Caller asks for a host bind mount — REST has no
                    # such surface and must refuse it outright.
                    volumes=[(host_dir, "/mnt/ro")],
                ),
            )

    # The host path itself must not be echoed back; the rejection is
    # about the missing volume:// reference, not about that directory.
    assert host_dir not in str(exc_info.value)
