"""Exercise the real build script's firmware selection with native ELF libraries."""

import ctypes
import importlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "linux", "Linux firmware packaging")
class LinuxFirmwareSourceTest(unittest.TestCase):
    def test_explicit_source_replaces_cached_default_and_invalidates_marker(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            source = root / "firmware source"
            source.mkdir()
            out = root / "out"
            libdir = out / "libkrunfw/lib64"
            libdir.mkdir(parents=True)
            library = libdir / "libkrunfw.so.5"
            default_c = root / "default.c"
            default_c.write_text('const char *proof(void) { return "default"; }\n')
            subprocess.run(
                [
                    "cc",
                    "-shared",
                    "-fPIC",
                    "-nostdlib",
                    str(default_c),
                    "-o",
                    str(library),
                ],
                check=True,
            )
            marker = out / "libkrunfw/.version-v5.4.0-63df4e4cc99d"
            marker.touch()
            (source / "kernel.c").write_text(
                'const char *proof(void) { return "dind"; }\n'
            )
            (source / "Makefile").write_text(
                ".PHONY: all install\nall:\n"
                "\tcc -shared -fPIC -nostdlib kernel.c -o libkrunfw.so.5\n"
                'install:\n\tmkdir -p "$(PREFIX)/lib64"\n'
                '\tcp libkrunfw.so.5 "$(PREFIX)/lib64/"\n'
            )
            # Only supply the build script's CPU-count dependency; all selection,
            # make invocation, installation and ELF fixups are production code.
            wrapper = root / "build.rs"
            wrapper.write_text(
                "mod num_cpus { pub fn get() -> usize { 1 } }\n"
                + f'include!(r#"{ROOT / "src/deps/libkrun-sys/build.rs"}"#);\n'
            )
            binary = root / "build"
            subprocess.run(
                [
                    "rustc",
                    "--edition=2021",
                    "--cfg",
                    'feature="krunfw"',
                    str(wrapper),
                    "-o",
                    str(binary),
                ],
                check=True,
                capture_output=True,
            )
            env = dict(
                os.environ,
                OUT_DIR=str(out),
                CARGO_MANIFEST_DIR=str(ROOT),
                CARGO_CFG_TARGET_ARCH="x86_64",
                BOXLITE_LIBKRUNFW_SOURCE=str(source),
            )
            env.pop("BOXLITE_DEPS_STUB", None)
            env.pop("BOXLITE_BUILD_LIBKRUNFW", None)
            result = subprocess.run(
                [str(binary)], check=False, env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            installed = ctypes.CDLL(str(library))
            installed.proof.restype = ctypes.c_char_p
            self.assertEqual(installed.proof(), b"dind", result.stdout)
            self.assertFalse(
                marker.exists(), "default cache marker must not survive override"
            )
            self.assertIn(
                "cargo:rerun-if-env-changed=BOXLITE_LIBKRUNFW_SOURCE", result.stdout
            )
            self.assertIn(
                f"cargo:rerun-if-changed={source / 'kernel.c'}", result.stdout
            )


class LinuxFirmwarePreparationTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT / "scripts/build"))
        try:
            self.kernel = importlib.import_module("prepare_dind_firmware")
        finally:
            sys.path.pop(0)

    def test_corrupt_release_never_reaches_packaging(self):
        kernel = self.kernel
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "firmware"
            with (
                patch.object(
                    kernel.urllib.request,
                    "urlopen",
                    return_value=io.BytesIO(b"corrupt ELF"),
                ),
                patch.object(kernel.subprocess, "run") as package,
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA256 mismatch"):
                    kernel.prepare_linux(output)
                package.assert_not_called()
                self.assertFalse((output / kernel.LINUX_KERNEL).exists())

    def test_corrupt_cache_is_not_trusted(self):
        kernel = self.kernel
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "firmware"
            output.mkdir()
            (output / kernel.LINUX_KERNEL).write_bytes(b"corrupt cache")
            with patch.object(kernel.subprocess, "run") as package:
                with self.assertRaisesRegex(RuntimeError, "Cached.*SHA256 mismatch"):
                    kernel.prepare_linux(output)
                package.assert_not_called()


if __name__ == "__main__":
    unittest.main()
