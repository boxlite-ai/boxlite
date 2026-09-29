"""Cache decisions and sparse artifact transfer for the internal image tool."""

import errno
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from compose import config, image_prebuild


class ImagePrebuildTests(unittest.TestCase):
    def test_l1_image_cache_uses_repo_local_home_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            with patch.object(config, "_detect_repo_root", return_value=repo), \
                 patch.dict(os.environ, {"BOXLITE_HOME": ""}):
                self.assertEqual(config.InfraConfig.load().boxlite_home, repo / ".apps-local" / ".bl" / "h")
            with patch.object(config, "_detect_repo_root", return_value=repo), \
                 patch.dict(os.environ, {"BOXLITE_HOME": str(repo / "custom-home")}):
                self.assertEqual(config.InfraConfig.load().boxlite_home, repo / "custom-home")

    def test_cache_hit_does_not_call_root_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "image.ext4"
            cache.write_bytes(b"cached")
            cfg = SimpleNamespace(boxlite_home=Path(directory))
            services = {"example": SimpleNamespace(image="example:1")}
            with patch.object(image_prebuild, "SERVICES", services), \
                 patch.object(image_prebuild, "_run_image_tool", return_value={"example:1": str(cache)}) as tool, \
                 patch.object(image_prebuild, "_run_root_builder") as root_builder:
                image_prebuild.ensure_l1_image_disks(cfg)
            tool.assert_called_once_with(cfg.boxlite_home, "path", ["example:1"])
            root_builder.assert_not_called()
            self.assertEqual(cache.read_bytes(), b"cached")

    def test_multiple_cache_misses_use_one_root_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            references = [f"example:{index}" for index in range(4)]
            paths = {ref: parent / "cache" / f"image-{i}.ext4"
                     for i, ref in enumerate(references)}
            exports = {ref: parent / "export" / path.name for ref, path in paths.items()}
            (parent / "export").mkdir()
            for ref, export in exports.items():
                export.write_bytes(ref.encode())
            cfg = SimpleNamespace(boxlite_home=parent / "home")
            services = {ref: SimpleNamespace(image=ref) for ref in references}
            with patch.object(image_prebuild, "SERVICES", services), \
                 patch.object(image_prebuild, "_run_image_tool", return_value={
                     ref: str(path) for ref, path in paths.items()
                 }), \
                 patch.object(image_prebuild, "_run_root_builder", return_value={
                     ref: str(export) for ref, export in exports.items()
                 }) as root_builder:
                image_prebuild.ensure_l1_image_disks(cfg)
            root_builder.assert_called_once_with(references, cfg)
            for ref, path in paths.items():
                self.assertEqual(path.read_bytes(), ref.encode())

    def test_root_process_prepares_only_missing_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "image.ext4"
            cfg = SimpleNamespace(boxlite_home=Path(directory))
            services = {"example": SimpleNamespace(image="example:1")}
            with patch.object(image_prebuild, "SERVICES", services), \
                 patch.object(image_prebuild.os, "geteuid", return_value=0), \
                 patch.object(image_prebuild, "_run_image_tool", side_effect=[
                     {"example:1": str(cache)}, {"example:1": str(cache)}
                 ]) as tool, \
                 patch.object(image_prebuild, "_run_root_builder") as root_builder:
                image_prebuild.ensure_l1_image_disks(cfg)
            self.assertEqual(tool.call_count, 2)
            self.assertEqual(tool.call_args.args, (cfg.boxlite_home, "prepare", ["example:1"]))
            root_builder.assert_not_called()

    def test_root_builder_leaves_progress_on_stderr(self):
        response = SimpleNamespace(
            returncode=0,
            stdout='BOXLITE_IMAGE_DISKS={"example:1":"/tmp/image.ext4"}\n',
            stderr="",
        )
        cfg = SimpleNamespace(repo_root=Path("/repo"))
        with patch.object(image_prebuild.shutil, "which", return_value="/usr/bin/sudo"), \
             patch.object(image_prebuild.subprocess, "run", return_value=response) as run:
            image_prebuild._run_root_builder(["example:1"], cfg)
        self.assertEqual(run.call_args.kwargs.get("stdout"), image_prebuild.subprocess.PIPE)
        self.assertIsNone(run.call_args.kwargs.get("stderr"))
        self.assertFalse(run.call_args.kwargs.get("capture_output", False))

    def test_internal_tool_rejects_incomplete_result(self):
        response = SimpleNamespace(returncode=0, stdout='BOXLITE_IMAGE_DISKS={"other":"/tmp/x"}\n', stderr="")
        cfg = SimpleNamespace(repo_root=Path("/repo"))
        with patch.object(image_prebuild.InfraConfig, "load", return_value=cfg), \
             patch.object(image_prebuild.subprocess, "run", return_value=response), \
             self.assertRaisesRegex(RuntimeError, "invalid disk paths"):
            image_prebuild._run_image_tool(Path("/home"), "path", ["example:1"])

    def test_root_builder_releases_temp_home_between_batches(self):
        references = [f"example:{index}" for index in range(4)]
        homes = []

        def build(home, mode, batch):
            self.assertEqual(mode, "prepare")
            homes.append(home)
            disk_dir = home / "images" / "disk-images"
            disk_dir.mkdir(parents=True)
            built = {}
            for ref in batch:
                disk = disk_dir / (ref.replace(":", "-") + ".ext4")
                with disk.open("wb") as image:
                    image.write(ref.encode())
                    image.truncate(16 * 1024 * 1024)
                built[ref] = str(disk)
            return built

        output = StringIO()
        progress = StringIO()
        with patch.object(image_prebuild.os, "geteuid", return_value=0), \
             patch.object(image_prebuild.os, "chown"), \
             patch.object(image_prebuild, "_run_image_tool", side_effect=build), \
             patch.dict(os.environ, {"SUDO_UID": str(os.getuid()), "SUDO_GID": str(os.getgid())}), \
             redirect_stdout(output), redirect_stderr(progress):
            image_prebuild._root_build(references)

        exported = json.loads(output.getvalue().split(image_prebuild._RESULT_PREFIX)[1])
        try:
            self.assertIn("batch 1/2", progress.getvalue())
            self.assertIn("batch 2/2", progress.getvalue())
            self.assertEqual(len(homes), 2)
            self.assertNotEqual(homes[0], homes[1])
            self.assertTrue(all(not home.exists() for home in homes))
            self.assertEqual(set(exported), set(references))
            for ref in references:
                disk = Path(exported[ref])
                with disk.open("rb") as image:
                    self.assertEqual(image.read(len(ref)), ref.encode())
                self.assertLess(disk.stat().st_blocks * 512, disk.stat().st_size // 2)
        finally:
            shutil.rmtree(Path(next(iter(exported.values()))).parent)

    def test_install_preserves_sparse_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            source = parent / "export" / "image.ext4"
            source.parent.mkdir()
            with source.open("wb") as disk:
                disk.write(b"ext4")
                disk.truncate(16 * 1024 * 1024)
            size = source.stat().st_size
            if source.stat().st_blocks * 512 >= size // 2:
                self.skipTest("filesystem does not support sparse files")
            cache = parent / "cache" / "image.ext4"
            image_prebuild._install_exports({"example:1": cache}, {"example:1": str(source)})
            self.assertEqual(cache.stat().st_size, size)
            self.assertLess(cache.stat().st_blocks * 512, size // 2)

    def test_cross_filesystem_install_rejects_dense_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            source = parent / "image.ext4"
            source.write_bytes(b"ext4")
            cache = parent / "cache" / source.name
            with patch.object(image_prebuild.os, "link", side_effect=OSError(errno.EXDEV, "cross-device")), \
                 self.assertRaisesRegex(RuntimeError, "same filesystem"):
                image_prebuild._install_exports({"example:1": cache}, {"example:1": str(source)})
            self.assertFalse(cache.exists())

    def test_wrong_export_name_cannot_enter_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            cache = parent / "cache" / "expected.ext4"
            export = parent / "wrong.ext4"
            export.write_bytes(b"wrong")
            with self.assertRaisesRegex(RuntimeError, "invalid disk"):
                image_prebuild._install_exports({"example:1": cache}, {"example:1": str(export)})
            self.assertFalse(cache.exists())


if __name__ == "__main__":
    unittest.main()
