"""Integration tests for SimpleBox.copy_in / copy_out option semantics.

Proves the Python SDK forwards copy options through to the core with
docker-cp semantics:
  - default include_parent=True keeps the source directory name
  - include_parent=False flattens the contents into the destination
  - overwrite=False refuses to clobber an existing file
  - copy_out writes a single file to the exact destination path

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun / Hypervisor.framework)
"""

from __future__ import annotations

import os

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def _box_test(box, flag: str, path: str) -> bool:
    """True iff `test <flag> <path>` succeeds in the box.

    Uses the exit code (reliable) rather than stdout, which can race with
    the async stdout pump.
    """
    result = await box.exec("test", flag, path)
    return result.exit_code == 0


async def test_copy_option_semantics(tmp_path):
    src_dir = tmp_path / "pkg"
    src_dir.mkdir()
    (src_dir / "a.txt").write_text("aaa")

    async with boxlite.SimpleBox(image="alpine:latest") as box:
        # 1. default include_parent=True keeps the source dir name.
        await box.exec("mkdir", "-p", "/root/d1")
        await box.copy_in(str(src_dir), "/root/d1")
        assert await _box_test(box, "-f", "/root/d1/pkg/a.txt"), (
            "default include_parent: /root/d1/pkg/a.txt should be a file"
        )

        # 2. include_parent=False flattens the contents into the destination.
        await box.exec("mkdir", "-p", "/root/d2")
        await box.copy_in(str(src_dir), "/root/d2", include_parent=False)
        assert await _box_test(box, "-f", "/root/d2/a.txt"), (
            "flatten: /root/d2/a.txt should be a file"
        )
        assert not await _box_test(box, "-e", "/root/d2/pkg"), (
            "flatten: /root/d2/pkg must not exist (no parent-dir wrapper)"
        )

        # 3. overwrite=False refuses to clobber an existing file.
        await box.exec("sh", "-c", "printf orig >/root/ov.txt")
        host_file = tmp_path / "new.txt"
        host_file.write_text("new")
        with pytest.raises(Exception):
            await box.copy_in(str(host_file), "/root/ov.txt", overwrite=False)
        unchanged = await box.exec("sh", "-c", 'test "$(cat /root/ov.txt)" = orig')
        assert unchanged.exit_code == 0, "overwrite=False: original must be unchanged"

        # 4. copy_out writes a single file to the exact host path.
        await box.exec("sh", "-c", "printf boxdata >/root/out.txt")
        host_dst = tmp_path / "out.txt"
        await box.copy_out("/root/out.txt", str(host_dst))
        assert host_dst.is_file(), "copy_out: host destination must be a regular file"
        assert host_dst.read_text() == "boxdata"
        assert not os.path.isdir(host_dst)

        # 5. follow_symlinks: default preserves the link; True dereferences it.
        lk = tmp_path / "lk"
        lk.mkdir()
        (lk / "target.txt").write_text("data")
        os.symlink("target.txt", lk / "link.txt")

        await box.exec("mkdir", "-p", "/root/lkdef")
        await box.copy_in(str(lk), "/root/lkdef")  # default follow_symlinks=False
        assert (
            await box.exec("test", "-L", "/root/lkdef/lk/link.txt")
        ).exit_code == 0, "default: link.txt should remain a symlink"

        await box.exec("mkdir", "-p", "/root/lkfol")
        await box.copy_in(str(lk), "/root/lkfol", follow_symlinks=True)
        assert (
            await box.exec("test", "-L", "/root/lkfol/lk/link.txt")
        ).exit_code != 0, (
            "follow_symlinks=True: link.txt should be dereferenced, not a symlink"
        )
        assert (
            await box.exec("test", "-f", "/root/lkfol/lk/link.txt")
        ).exit_code == 0, "follow_symlinks=True: link.txt should be a regular file"

        # 6. copy_out dir default include_parent=True keeps the source dir name.
        await box.exec("sh", "-c", "mkdir -p /root/op && printf y >/root/op/y.txt")
        host_op = tmp_path / "op_out"
        host_op.mkdir()
        await box.copy_out("/root/op", str(host_op))
        assert (host_op / "op" / "y.txt").is_file(), (
            "copy_out default: <host>/op/y.txt should be a regular file"
        )

        # 7. copy_out overwrite=False leaves an existing host file unchanged.
        await box.exec("sh", "-c", "printf boxnew >/root/ow.txt")
        host_ow = tmp_path / "ow.txt"
        host_ow.write_text("hostold")
        with pytest.raises(Exception):
            await box.copy_out("/root/ow.txt", str(host_ow), overwrite=False)
        assert host_ow.read_text() == "hostold", (
            "copy_out overwrite=False: host file must be unchanged"
        )

        # 8. copy_out follow_symlinks: default preserves, True dereferences.
        await box.exec(
            "sh",
            "-c",
            "mkdir -p /root/lkb && printf data >/root/lkb/target.txt "
            "&& ln -sf target.txt /root/lkb/link.txt",
        )
        host_def = tmp_path / "lkb_def"
        host_def.mkdir()
        await box.copy_out("/root/lkb", str(host_def))
        assert os.path.islink(host_def / "lkb" / "link.txt"), (
            "copy_out default: link.txt should remain a symlink on host"
        )

        host_fol = tmp_path / "lkb_fol"
        host_fol.mkdir()
        await box.copy_out("/root/lkb", str(host_fol), follow_symlinks=True)
        assert not os.path.islink(host_fol / "lkb" / "link.txt"), (
            "copy_out follow_symlinks=True: link.txt should be dereferenced"
        )
        assert (host_fol / "lkb" / "link.txt").is_file(), (
            "copy_out follow_symlinks=True: link.txt should be a regular file"
        )

        # 9. copy_out dir include_parent=False flattens into the host dir.
        await box.exec("sh", "-c", "mkdir -p /root/odf && printf z >/root/odf/z.txt")
        host_odf = tmp_path / "odf_out"
        host_odf.mkdir()
        await box.copy_out("/root/odf", str(host_odf), include_parent=False)
        assert (host_odf / "z.txt").is_file(), (
            "copy_out include_parent=False: <host>/z.txt should be a file"
        )
        assert not (host_odf / "odf").exists(), (
            "copy_out include_parent=False: no odf/ wrapper"
        )
