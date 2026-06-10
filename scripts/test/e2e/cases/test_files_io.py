"""E2E port of `src/boxlite/tests/copy.rs`.

Verifies that the SDK → API → Runner → VM `copy_in` / `copy_out` chain:
  - round-trips text and binary files unchanged
  - recurses into directories
  - propagates `include_parent` / `overwrite` options end-to-end

`copy.rs` covers 18 sub-cases at the local-FFI layer. Re-running all of
those over the REST chain would burn ~10 boxes for low marginal
coverage. This file keeps cost low (one shared box across cases) and
focuses on the bytes-over-the-wire surface: the parts where the
REST/runner path could plausibly diverge from local FFI.

Path note: copy_in / copy_out operate on the box's container rootfs,
not tmpfs mounts. `/tmp` in the guest is a tmpfs (its writes never hit
the rootfs disk and so are invisible to copy_out). Always copy under
`/root/...` to keep tests deterministic.
"""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
from pathlib import Path

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_copy_in_text_roundtrips_byte_exact(box):
    """A tiny text file written on the host appears in the guest with
    byte-exact content (including a multi-byte UTF-8 codepoint)."""
    payload = "boxlite-e2e-copy_in\nline2\nüñîçødé\n"
    with tempfile.TemporaryDirectory() as tmpdir:
        host_file = Path(tmpdir) / "hello.txt"
        host_file.write_bytes(payload.encode("utf-8"))

        # Dest is a FULL file path (matching copy.rs::single_file_roundtrip).
        await box.copy_in(str(host_file), "/root/hello.txt")

        ex = await box.exec("cat", ["/root/hello.txt"], None)
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"cat of copied file failed: rc={rc.exit_code}"
    assert out == payload, (
        f"copy_in mangled bytes: sent {payload!r}, got {out!r}"
    )


@pytest.mark.asyncio
async def test_copy_out_binary_roundtrips_sha256(box):
    """A 256 KB random blob created inside the guest, copied to the host,
    matches the guest-side sha256. Catches any silent transcoding /
    truncation in the streaming path.

    Writes to /root (rootfs disk) — `/tmp` is tmpfs and copy_out can't
    see it."""
    # Generate blob on the rootfs disk + hash it (guest hash is the
    # ground truth).
    ex = await box.exec(
        "sh", ["-c",
               "dd if=/dev/urandom of=/root/blob bs=4096 count=64 2>/dev/null "
               "&& sha256sum /root/blob && sync"], None,
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0, f"blob+sha256 in guest failed: rc={rc.exit_code}"
    guest_sha = out.split()[0]
    assert len(guest_sha) == 64, f"unexpected sha256 line: {out!r}"

    with tempfile.TemporaryDirectory() as tmpdir:
        dest_file = Path(tmpdir) / "blob_copy"
        await box.copy_out("/root/blob", str(dest_file))
        assert dest_file.exists(), (
            f"copy_out produced no file at {dest_file}: "
            f"contents={list(Path(tmpdir).rglob('*'))}"
        )
        host_sha = hashlib.sha256(dest_file.read_bytes()).hexdigest()

    assert host_sha == guest_sha, (
        f"binary copy_out corruption: host={host_sha} guest={guest_sha}"
    )


@pytest.mark.asyncio
async def test_copy_in_directory_include_parent_false(box):
    """copy_in a directory with include_parent=False flattens its
    contents into the destination dir. Pins the option-propagation
    contract for the REST path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir) / "tree"
        (root / "sub").mkdir(parents=True)
        (root / "top.txt").write_text("top\n")
        (root / "sub" / "deep.txt").write_text("deep\n")

        opts = boxlite.CopyOptions(
            recursive=True,
            overwrite=True,
            follow_symlinks=False,
            include_parent=False,
        )
        await box.copy_in(str(root), "/root/flatdest/", copy_options=opts)

        ex = await box.exec(
            "sh", ["-c", "find /root/flatdest -type f | sort"], None,
        )
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"find inside guest failed: rc={rc.exit_code}"
    files = [ln for ln in out.split("\n") if ln]
    assert "/root/flatdest/top.txt" in files, f"top file missing: {files}"
    assert "/root/flatdest/sub/deep.txt" in files, (
        f"nested file missing — copy_in didn't recurse: {files}"
    )


@pytest.mark.asyncio
async def test_copy_in_overwrite_false_rejects_conflict(rt, image):
    """`overwrite=False` MUST refuse to clobber an existing file. The
    runtime behaviour can be either a raised exception or a no-op (FFI
    raises) — either is acceptable; the contract is *the guest content
    must be unchanged*.

    Tightens the boundary between API DTO defaults (overwrite=True is
    common) and the per-call override."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        # Seed the guest with content the host file should NOT overwrite.
        ex = await b.exec(
            "sh", ["-c", "echo guest-original > /root/v.txt"], None,
        )
        await drain(ex)
        await asyncio.wait_for(ex.wait(), timeout=30)

        with tempfile.TemporaryDirectory() as tmpdir:
            host_file = Path(tmpdir) / "v.txt"
            host_file.write_text("host-replacement\n")
            opts = boxlite.CopyOptions(
                recursive=False,
                overwrite=False,
                follow_symlinks=False,
                include_parent=False,
            )
            # The FFI suite asserts this raises; over REST a non-raising
            # silent-keep is also a correct implementation. Accept both.
            try:
                await b.copy_in(str(host_file), "/root/v.txt", copy_options=opts)
            except Exception:
                pass

            ex = await b.exec("cat", ["/root/v.txt"], None)
            out, _ = await drain(ex)
            await asyncio.wait_for(ex.wait(), timeout=30)
        assert "guest-original" in out, (
            f"overwrite=False replaced guest content: {out!r}"
        )
        assert "host-replacement" not in out, (
            f"overwrite=False leaked host content: {out!r}"
        )
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass
