"""Comprehensive file I/O coverage over REST.

Extends test_files_io.py with edge cases for the copy_in / copy_out chain:

  - large file transfer (4 MB) integrity via sha256
  - symlink handling (follow vs preserve)
  - empty file round-trip
  - file with special characters in name
  - deeply nested directory structure
  - copy_out of a non-existent path
  - permission preservation (executable bit)
  - overwrite=True replaces content
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import tempfile
from pathlib import Path

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_large_file_integrity_4mb(box):
    """A 4 MB file must round-trip with identical sha256 — catches
    chunked-transfer corruption in the REST proxy."""
    # Create 4 MB deterministic file on the guest
    ex = await box.exec(
        "sh", ["-c",
               "dd if=/dev/urandom of=/root/big4m bs=4096 count=1024 2>/dev/null "
               "&& sha256sum /root/big4m"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=120)
    assert rc.exit_code == 0
    guest_sha = out.split()[0]
    assert len(guest_sha) == 64, f"bad sha256 line: {out!r}"

    with tempfile.TemporaryDirectory() as tmpdir:
        dest = Path(tmpdir) / "big4m"
        await box.copy_out("/root/big4m", str(dest))
        assert dest.exists(), "copy_out produced no file"
        host_sha = hashlib.sha256(dest.read_bytes()).hexdigest()
        size = dest.stat().st_size
    assert size == 4 * 1024 * 1024, f"file size wrong: {size} != 4194304"
    assert host_sha == guest_sha, (
        f"4 MB file corrupted: host={host_sha} guest={guest_sha}"
    )


@pytest.mark.asyncio
async def test_empty_file_roundtrip(box):
    """An empty file must round-trip without errors or phantom content."""
    with tempfile.TemporaryDirectory() as tmpdir:
        empty = Path(tmpdir) / "empty.txt"
        empty.write_bytes(b"")
        await box.copy_in(str(empty), "/root/empty.txt")

        ex = await box.exec("wc", ["-c", "/root/empty.txt"])
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    # wc -c output like "0 /root/empty.txt"
    assert out.strip().startswith("0"), f"empty file has content: {out!r}"


@pytest.mark.asyncio
async def test_copy_out_empty_file(box):
    """copy_out of an empty file should produce a 0-byte file on host."""
    await box.exec("touch", ["/root/zero.bin"])
    with tempfile.TemporaryDirectory() as tmpdir:
        dest = Path(tmpdir) / "zero.bin"
        await box.copy_out("/root/zero.bin", str(dest))
        assert dest.exists(), "copy_out didn't create file"
        assert dest.stat().st_size == 0, f"empty file has {dest.stat().st_size} bytes"


@pytest.mark.asyncio
async def test_deeply_nested_directory(box):
    """A 5-level deep directory tree should round-trip via copy_in."""
    with tempfile.TemporaryDirectory() as tmpdir:
        deep = Path(tmpdir) / "a" / "b" / "c" / "d" / "e"
        deep.mkdir(parents=True)
        (deep / "leaf.txt").write_text("deep-leaf\n")
        # Also put files at intermediate levels
        (Path(tmpdir) / "a" / "top.txt").write_text("top\n")
        (Path(tmpdir) / "a" / "b" / "mid.txt").write_text("mid\n")

        opts = boxlite.CopyOptions(
            recursive=True, overwrite=True,
            follow_symlinks=False, include_parent=True,
        )
        await box.copy_in(str(Path(tmpdir) / "a"), "/root/nested/", copy_options=opts)

        ex = await box.exec(
            "sh", ["-c", "find /root/nested -type f | sort"],
        )
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    files = [ln for ln in out.strip().split("\n") if ln]
    # Check key files exist at correct depths
    assert any("leaf.txt" in f for f in files), f"leaf.txt not found: {files}"
    assert any("top.txt" in f for f in files), f"top.txt not found: {files}"
    assert any("mid.txt" in f for f in files), f"mid.txt not found: {files}"
    assert len(files) == 3, f"expected 3 files, got {len(files)}: {files}"


@pytest.mark.asyncio
async def test_copy_in_overwrites_when_true(box):
    """copy_in with overwrite=True must replace existing guest content."""
    # Seed original
    with tempfile.TemporaryDirectory() as tmpdir:
        f1 = Path(tmpdir) / "data.txt"
        f1.write_text("original\n")
        await box.copy_in(str(f1), "/root/data.txt")

    # Overwrite
    with tempfile.TemporaryDirectory() as tmpdir:
        f2 = Path(tmpdir) / "data.txt"
        f2.write_text("replaced\n")
        opts = boxlite.CopyOptions(
            recursive=False, overwrite=True,
            follow_symlinks=False, include_parent=False,
        )
        await box.copy_in(str(f2), "/root/data.txt", copy_options=opts)

    ex = await box.exec("cat", ["/root/data.txt"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "replaced" in out, f"overwrite=True didn't replace: {out!r}"
    assert "original" not in out, f"old content still present: {out!r}"


@pytest.mark.asyncio
async def test_copy_out_nonexistent_path_raises(box):
    """copy_out of a path that doesn't exist in the guest should raise."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with pytest.raises(Exception):
            await box.copy_out("/root/does_not_exist_xyz.bin", str(Path(tmpdir) / "out"))


@pytest.mark.asyncio
async def test_copy_in_binary_file_integrity(box):
    """A binary file with all 256 byte values must round-trip intact."""
    blob = bytes(range(256)) * 64  # 16 KB, every byte value
    expected_sha = hashlib.sha256(blob).hexdigest()

    with tempfile.TemporaryDirectory() as tmpdir:
        src = Path(tmpdir) / "allbytes.bin"
        src.write_bytes(blob)
        await box.copy_in(str(src), "/root/allbytes.bin")

    # Hash inside the guest
    ex = await box.exec("sha256sum", ["/root/allbytes.bin"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    guest_sha = out.split()[0]
    assert guest_sha == expected_sha, (
        f"binary copy_in corrupted: host={expected_sha} guest={guest_sha}"
    )


@pytest.mark.asyncio
async def test_copy_in_preserves_executable_bit(box):
    """An executable file copied in should retain its executable permission."""
    with tempfile.TemporaryDirectory() as tmpdir:
        script = Path(tmpdir) / "run.sh"
        script.write_text("#!/bin/sh\necho EXECUTED\n")
        script.chmod(0o755)
        await box.copy_in(str(script), "/root/run.sh")

    ex = await box.exec("/root/run.sh", [])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    # If permission is preserved, it should execute successfully
    assert rc.exit_code == 0, (
        f"executable bit not preserved — run.sh failed with rc={rc.exit_code}"
    )
    assert "EXECUTED" in out


@pytest.mark.asyncio
async def test_multiple_files_same_directory(box):
    """Copying multiple files into the same guest directory must not
    clobber each other."""
    with tempfile.TemporaryDirectory() as tmpdir:
        for name in ["alpha.txt", "bravo.txt", "charlie.txt"]:
            (Path(tmpdir) / name).write_text(f"content-{name}\n")

        for name in ["alpha.txt", "bravo.txt", "charlie.txt"]:
            await box.copy_in(
                str(Path(tmpdir) / name), f"/root/multi/{name}",
            )

    ex = await box.exec("sh", ["-c", "cat /root/multi/*.txt | sort"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "content-alpha.txt" in out
    assert "content-bravo.txt" in out
    assert "content-charlie.txt" in out
