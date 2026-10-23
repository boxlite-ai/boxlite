"""E2E pin: the REST surface does NOT accept host bind mounts.

The cloud / managed runtime intentionally dropped host bind mounts
(see PR #639 "remove host bind mounts; only managed volumes
allowed"). A REST-mode `BoxOptions` carrying `volumes=[(host_path,
guest_path, ...)]` must not produce a box with that host path
mounted.

The rejection is explicit, not silent, and it happens in the
client: a host bind goes only to a server whose `GET /v1/config`
advertises `host_path_volumes_enabled` (`boxlite serve
--host-path-root`). The cloud does not, so the bind never leaves
the SDK. Failing loud is the contract worth pinning: a silently ignored
bind mount leaves the caller believing the guest can see a host
directory it cannot.

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
    rejected. A tuple is a host bind, and the REST runtime refuses one
    when the server does not advertise host-path support, before the
    create request is built, so the box is never created and no host
    path can reach the guest."""
    with tempfile.TemporaryDirectory(prefix="boxlite_e2e_hostmount_") as host_dir:
        with pytest.raises(Exception, match="volume") as exc_info:
            await rt.create(
                boxlite.BoxOptions(
                    image=image,
                    auto_remove=True,
                    # Caller asks for a host bind mount — the cloud
                    # binds none, so the client must refuse it.
                    volumes=[(host_dir, "/mnt/ro")],
                ),
            )

    # The host path itself must not be echoed back; the rejection is
    # about the mount kind, not about that directory.
    assert host_dir not in str(exc_info.value)
