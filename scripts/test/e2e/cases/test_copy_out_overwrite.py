"""E2E coverage of `box.copy_out(..., overwrite=False)`.

Symmetric to PR #691 (`copy_in` overwrite=False), but for the receive
side. Without the SDK-side check, the contract `box.copy_out(...,
overwrite=False)` is silently violated — a host file gets replaced
with guest content the caller specifically said they did not want
written.
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import boxlite
import pytest

from conftest import drain


async def _write_guest(box, path: str, content: str) -> None:
    ex = await box.exec(
        "sh",
        ["-c", f"mkdir -p $(dirname {path}) && printf %s {content!r} > {path}"],
        None,
    )
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"seed write failed: rc={rc.exit_code}"


@pytest.mark.asyncio
async def test_copy_out_overwrite_false_raises_already_exists(box):
    """host_dst already exists + overwrite=False must raise an error
    that names the conflict ('already exists') BEFORE any tar download
    or extraction work — not after a tangential extract failure
    (which a fix-less baseline produces because the SDK's extract path
    tries to treat a pre-existing file as a directory)."""
    await _write_guest(box, "/root/payload.txt", "guest-bytes")

    with tempfile.TemporaryDirectory() as tmpdir:
        host_dst = Path(tmpdir) / "preexisting.txt"
        host_dst.write_text("host-original-content", encoding="utf-8")

        opts = boxlite.CopyOptions(
            recursive=True,
            overwrite=False,
            follow_symlinks=False,
            include_parent=False,
        )
        with pytest.raises(Exception) as exc_info:
            await box.copy_out(
                "/root/payload.txt", str(host_dst), copy_options=opts
            )
        msg = str(exc_info.value).lower()
        assert "already exists" in msg, (
            f"copy_out(overwrite=False) should refuse with 'already exists' "
            f"when host_dst is present; instead got: {exc_info.value!r}"
        )
        # Host content should also be unchanged.
        assert host_dst.read_text(encoding="utf-8") == "host-original-content", (
            f"host file content changed; got {host_dst.read_text()!r}"
        )


@pytest.mark.asyncio
async def test_copy_out_overwrite_false_does_not_refuse_when_dest_absent(box):
    """Counter-pin: when host_dst doesn't exist, overwrite=False must
    NOT short-circuit with 'already exists'."""
    await _write_guest(box, "/root/payload2.txt", "guest-bytes-2")

    with tempfile.TemporaryDirectory() as tmpdir:
        host_dst = Path(tmpdir) / "absent_pre_copy.txt"
        # host_dst does NOT exist on entry.

        opts = boxlite.CopyOptions(
            recursive=True,
            overwrite=False,
            follow_symlinks=False,
            include_parent=False,
        )
        try:
            await box.copy_out("/root/payload2.txt", str(host_dst), copy_options=opts)
        except RuntimeError as e:
            msg = str(e).lower()
            assert "already exists" not in msg, (
                f"overwrite=False guard fired on non-existent dest: {e!r}"
            )
