"""Regression test for GHSA-g6ww-w5j2-r7x3 (read-only volume remount bypass).

A host directory mounted with ``read_only=True`` must stay read-only even
against a malicious guest that holds the container's full capability set and
runs ``mount -o remount,rw``. Before the v0.9.0 fix the guest could remount
the virtiofs share read-write (it had ``CAP_SYS_ADMIN``) and write through to
the host.

This test replays the exact attack sequence from the published advisory PoC
and asserts the host file is never modified. It is the Python-SDK counterpart
of ``src/boxlite/tests/security_enforcement.rs``.

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun + Hypervisor.framework)
"""

from __future__ import annotations

import os
import tempfile
import warnings

import pytest

import boxlite

GUEST_MOUNT = "/mnt/sensitive"
ORIGINAL = "original content\n"
ATTACK_PAYLOAD = "modified content"


@pytest.fixture
def runtime(shared_sync_runtime):
    """Reuse the shared sync runtime (one runtime per ~/.boxlite flock)."""
    return shared_sync_runtime


def _sh(sandbox, command):
    """Run a shell command in the guest, return (exit_code, merged stdout)."""
    execution = sandbox.exec("sh", ["-c", command])
    stdout = "".join(list(execution.stdout()))
    result = execution.wait()
    return result.exit_code, stdout


@pytest.mark.integration
class TestReadonlyVolumeRemountBypass:
    """GHSA-g6ww-w5j2-r7x3: read-only volume must resist a remount,rw attack."""

    def test_remount_rw_cannot_reach_host(self, runtime):
        host_dir = tempfile.mkdtemp(prefix="virtiofs_ro_poc_")
        ro_file = os.path.join(host_dir, "read_only.txt")
        with open(ro_file, "w") as f:
            f.write(ORIGINAL)

        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                volumes=[(host_dir, GUEST_MOUNT, True)],  # read_only=True
                memory_mib=512,
                cpus=1,
                auto_remove=False,
            )
        )
        try:
            # The share is exposed read-only to the guest.
            _, mounts = _sh(sandbox, "cat /proc/mounts | grep sensitive")
            assert " ro," in mounts, "volume not mounted read-only: %r" % (mounts,)

            # A direct write is rejected (client-side MS_RDONLY active).
            write_exit, _ = _sh(
                sandbox,
                "echo '"
                + ATTACK_PAYLOAD
                + "' > "
                + GUEST_MOUNT
                + "/read_only.txt 2>&1",
            )
            assert write_exit != 0, "initial write to read-only volume should fail"

            # ATTACK: try to remount the share read-write.
            _sh(sandbox, "mount -o remount,rw " + GUEST_MOUNT + " 2>&1")

            # The mount must still be read-only after the remount attempt.
            _, after = _sh(sandbox, "cat /proc/mounts | grep sensitive")
            assert " ro," in after, "volume became writable after remount: %r" % (
                after,
            )
            assert " rw," not in after, "volume became writable after remount: %r" % (
                after,
            )

            # A post-attack write must still fail, and the guest-visible
            # content must be unchanged.
            write2_exit, _ = _sh(
                sandbox,
                "echo '"
                + ATTACK_PAYLOAD
                + "' > "
                + GUEST_MOUNT
                + "/read_only.txt 2>&1",
            )
            assert write2_exit != 0, "write after remount bypass should still fail"

            _, guest_view = _sh(sandbox, "cat " + GUEST_MOUNT + "/read_only.txt")
            assert guest_view == ORIGINAL, "guest modified the file: %r" % (guest_view,)

            # HOST VERIFICATION - the advisory's own exploit oracle: if the
            # host file now reads ATTACK_PAYLOAD the sandbox was escaped.
            with open(ro_file) as f:
                host_content = f.read()
            assert host_content == ORIGINAL, (
                "read-only volume bypass: host file was modified from inside "
                "the sandbox (got %r)" % (host_content,)
            )
        finally:
            sandbox.stop()
            try:
                os.remove(ro_file)
                os.rmdir(host_dir)
            except OSError as e:
                # Best-effort cleanup: do not fail the test during teardown,
                # but surface the issue for debugging.
                warnings.warn(f"teardown cleanup failed: {e!r}")
