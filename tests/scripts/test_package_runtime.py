"""Exercise runtime release packaging without a native build."""

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BINARIES = ("boxlite-shim", "boxlite-guest", "guest-mke2fs", "guest-resize2fs")


class PackageRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.scripts = self.workspace / "scripts" / "build"
        self.scripts.mkdir(parents=True)
        for name in ("package-runtime.sh", "cargo-runtime-dir.sh"):
            shutil.copyfile(ROOT / "scripts" / "build" / name, self.scripts / name)
        (self.workspace / "Cargo.toml").write_text('[workspace.package]\nversion = "0.1.0"\n')
        self.archive = self.workspace / "boxlite-runtime-v0.1.0-linux-x64-gnu.tar.gz"

        runtime = self.workspace / "out" / "runtime"
        runtime.mkdir(parents=True)
        for name in BINARIES:
            executable = runtime / name
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
        firmware = runtime.parent / "firmware.so"
        firmware.write_bytes(b"runtime data")
        (runtime / "libkrunfw.so").symlink_to(firmware)

        cargo = self.workspace / "cargo"
        cargo.write_text(
            '#!/bin/sh\n'
            'case "$1" in\n'
            '  pkgid) printf "%s\\n" "$TEST_PACKAGE_ID" ;;\n'
            '  build) printf "%s\\n" "$TEST_BUILD_MESSAGE" ;;\n'
            '  *) exit 2 ;;\n'
            'esac\n'
        )
        cargo.chmod(0o755)
        package_id = "path+file:///boxlite#0.1.0"
        self.env = dict(os.environ, PATH=f"{self.workspace}:{os.environ['PATH']}")
        self.env["TEST_PACKAGE_ID"] = package_id
        self.env["TEST_BUILD_MESSAGE"] = json.dumps({
            "reason": "build-script-executed",
            "package_id": package_id,
            "out_dir": str(runtime.parent),
        })

    def package(self):
        return subprocess.run(
            ["bash", str(self.scripts / "package-runtime.sh"), "linux-x64-gnu"],
            env=self.env, capture_output=True, text=True, timeout=30, umask=0o077,
        )

    def test_build_leaves_only_a_host_readable_archive(self):
        before = set(self.workspace.iterdir())
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.workspace.iterdir()) - before, {self.archive})
        self.assertEqual(oct(stat.S_IMODE(self.archive.stat().st_mode)), "0o644")
        with tarfile.open(self.archive) as archive:
            for executable in BINARIES:
                member = archive.getmember(f"boxlite-runtime/{executable}")
                self.assertTrue(member.isfile())
                self.assertEqual(member.mode, 0o755)
            firmware = archive.getmember("boxlite-runtime/libkrunfw.so")
            self.assertTrue(firmware.isfile())
            with archive.extractfile(firmware) as contents:
                self.assertEqual(contents.read(), b"runtime data")

    def test_tar_failure_removes_temporary_output(self):
        tar = self.workspace / "tar"
        tar.write_text('#!/bin/sh\nprintf partial > "$2"\nexit 23\n')
        tar.chmod(0o755)
        before = set(self.workspace.iterdir())
        result = self.package()
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(set(self.workspace.iterdir()), before)
