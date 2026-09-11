"""E2E P0 (multi-tenant isolation): one box cannot read another box's files.

Requirement (Sandbox platform §6.1 / §12.4): different sandboxes are isolated
— box B must not be able to read, list, or otherwise reach box A's filesystem.
Each box is a separate microVM with its own root filesystem, so a path written
in A must simply not exist in B.

This is the negative security assertion the suite was missing: it writes a
unique marker into box A's rootfs and proves box B (created independently)
cannot see the marker, the file, or A's data directory.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import drain

import boxlite

MARKER = "tenant-A-only-4c7e21"
SECRET_PATH = "/root/tenant_a_secret.txt"


async def _run(box, cmd: str) -> tuple[int, str, str]:
    ex = await box.exec("sh", ["-c", cmd], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    return rc.exit_code, out, err


@pytest.mark.asyncio
async def test_box_b_cannot_read_box_a_filesystem(rt, image):
    a = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        # A writes a private marker into its own rootfs.
        rc, _, err = await _run(a, f"printf '%s' '{MARKER}' > {SECRET_PATH} && sync")
        assert rc == 0, f"box A failed to write its secret: rc={rc} stderr={err!r}"

        # Sanity: A can read it back (proves the write is real, not a no-op).
        rc, out, _ = await _run(a, f"cat {SECRET_PATH}")
        assert rc == 0 and MARKER in out, f"box A cannot read its own secret: {out!r}"

        # B must NOT see A's file at all.
        rc, out, _ = await _run(b, f"cat {SECRET_PATH} 2>/dev/null; echo RC=$?")
        assert MARKER not in out, (
            f"ISOLATION BREACH: box B read box A's secret file → {out!r}"
        )
        assert "RC=0" not in out, (
            f"ISOLATION BREACH: {SECRET_PATH} is readable inside box B → {out!r}"
        )

        # And the marker must not appear anywhere reachable from B's rootfs.
        # Exclude the virtual filesystems: grep -rl over /proc (e.g.
        # /proc/kcore) can stall past the exec timeout.
        #
        # grep's exit status is the signal, NOT its stdout. A sentinel echoed
        # after the pipeline runs unconditionally, so "no output" cannot tell a
        # clean search apart from one that never ran — a missing `timeout`
        # binary, a grep error, or a kill at the timeout all produce the same
        # empty stdout and would pass silently.
        #   1   searched, no match  → the only acceptable outcome
        #   0   match               → isolation breach
        #   >=2 grep error, 124 killed by timeout → inconclusive, must fail
        rc, out, _ = await _run(
            b,
            f"hits=$(timeout 20 grep -rl '{MARKER}' "
            "--exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "
            "--exclude-dir=run --exclude-dir=tmp / 2>/dev/null); "
            'echo "GREP_RC=$?"; printf %s "$hits" | head -n1',
        )
        assert "GREP_RC=1" in out, (
            "marker search over box B did not finish as 'searched, found "
            "nothing' (GREP_RC=1). GREP_RC=0 means ISOLATION BREACH; >=2 means "
            f"grep errored; 124 means it hit the 20s timeout → {out!r}"
        )
    finally:
        await rt.remove(a.id, force=True)
        await rt.remove(b.id, force=True)
