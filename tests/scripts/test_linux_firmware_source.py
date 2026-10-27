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


@unittest.skipUnless(
    sys.platform == "linux" and os.uname().machine == "x86_64", "Linux x86_64 firmware"
)
class LinuxFirmwareVariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="boxlite firmware ")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.root = Path(cls.scratch.name)
        wrapper = cls.root / "build.rs"
        wrapper.write_text(
            "mod num_cpus { pub fn get() -> usize { 1 } }\n"
            + f'include!(r#"{ROOT / "src/deps/libkrun-sys/build.rs"}"#);\n'
        )
        cls.binary = cls.root / "build"
        subprocess.run(
            [
                "rustc",
                "--edition=2021",
                "--cfg",
                'feature="krunfw"',
                str(wrapper),
                "-o",
                str(cls.binary),
            ],
            check=True,
            capture_output=True,
        )
        # Exercise the real selection and checksum verification without network access.
        curl = cls.root / "curl"
        curl.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$4" > "$REQUEST_LOG"\nprintf corrupt > "$3"\n'
        )
        curl.chmod(0o755)

    def run_build(self, variant, cached=None):
        scratch = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(scratch.cleanup)
        out = Path(scratch.name)
        install = out / "libkrunfw"
        if cached:
            lib = install / "lib64"
            lib.mkdir(parents=True)
            subprocess.run(
                [
                    "cc",
                    "-shared",
                    "-fPIC",
                    "-x",
                    "c",
                    "-",
                    "-o",
                    str(lib / "libkrunfw.so.5"),
                ],
                input="int proof(void) { return 1; }",
                text=True,
                check=True,
                capture_output=True,
            )
            (install / f".version-v5.4.0-{cached}").touch()
        env = dict(
            os.environ,
            OUT_DIR=str(out),
            CARGO_MANIFEST_DIR=str(ROOT),
            CARGO_CFG_TARGET_ARCH="x86_64",
            PATH=f"{self.root}:{os.environ['PATH']}",
            REQUEST_LOG=str(out / "requested-url"),
        )
        for name in [
            "BOXLITE_DEPS_STUB",
            "BOXLITE_BUILD_LIBKRUNFW",
            "BOXLITE_LIBKRUNFW_SOURCE",
            "BOXLITE_LIBKRUNFW_VARIANT",
        ]:
            env.pop(name, None)
        if variant is not None:
            env["BOXLITE_LIBKRUNFW_VARIANT"] = variant
        result = subprocess.run(
            [str(self.binary)], env=env, check=False, capture_output=True, text=True
        )
        return result, out

    def test_selects_release_and_rejects_corrupt_download(self):
        for variant, asset in [
            (None, "libkrunfw-x86_64.tgz"),
            ("generic", "libkrunfw-x86_64.tgz"),
            ("dind", "libkrunfw-dind-x86_64.tgz"),
        ]:
            with self.subTest(variant=variant):
                result, out = self.run_build(variant)
                self.assertEqual(
                    (out / "requested-url").read_text().strip().split("/")[-1], asset
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SHA256 mismatch", result.stderr)
                self.assertEqual(list((out / "libkrunfw").glob(".version-*")), [])

    def test_switching_variant_invalidates_both_cache_directions(self):
        for variant, cached, asset in [
            ("dind", "63df4e4cc99d", "libkrunfw-dind-x86_64.tgz"),
            (None, "28bd8aa05a6c", "libkrunfw-x86_64.tgz"),
        ]:
            with self.subTest(variant=variant):
                result, out = self.run_build(variant, cached)
                self.assertTrue(
                    (out / "requested-url").exists(),
                    "stale firmware cache suppressed download",
                )
                self.assertTrue(
                    (out / "requested-url").read_text().strip().endswith(asset)
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SHA256 mismatch", result.stderr)
                self.assertEqual(list((out / "libkrunfw").glob(".version-*")), [])

    def test_unset_and_generic_reuse_generic_cache(self):
        for variant in [None, "generic"]:
            with self.subTest(variant=variant):
                result, out = self.run_build(variant, "63df4e4cc99d")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((out / "requested-url").exists())
                self.assertIn(
                    "cargo:rerun-if-env-changed=BOXLITE_LIBKRUNFW_VARIANT",
                    result.stdout,
                )

    def test_invalid_variant_fails_before_download(self):
        for variant in ["typo", ""]:
            with self.subTest(variant=variant):
                result, out = self.run_build(variant)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "BOXLITE_LIBKRUNFW_VARIANT must be generic or dind", result.stderr
                )
                self.assertFalse((out / "requested-url").exists())


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
