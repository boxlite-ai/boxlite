"""Exercise macOS firmware selection through the real build script and dylibs."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "darwin", "macOS firmware packaging")
class MacOSFirmwareSourceTest(unittest.TestCase):
    def test_override_replaces_cached_default_and_unsetting_restores_it(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve()
            out = root / "output with spaces"
            default = out / "libkrunfw-src-v5.4.0-1d1b848cee70/libkrunfw"
            override = root / "firmware source"
            for source, marker in [(default, "default"), (override, "dind")]:
                source.mkdir(parents=True)
                (source / "kernel.c").write_text(
                    f'const char *proof(void) {{ return "{marker}"; }}\n'
                )
                (source / "kernel.config").write_text("CONFIG_IP_VS=y\n")
                (source / "Makefile").write_text(
                    ".PHONY: all install\nall:\n"
                    "\tcc -dynamiclib kernel.c -o libkrunfw.5.dylib\n"
                    'install:\n\tmkdir -p "$(PREFIX)/lib"\n'
                    '\tcp libkrunfw.5.dylib "$(PREFIX)/lib/"\n'
                )
            # Supply only the CPU-count dependency; selection, compilation,
            # installation, install-name fixups and signing are production code.
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
            env = dict(os.environ, OUT_DIR=str(out), CARGO_MANIFEST_DIR=str(ROOT))
            for name in [
                "BOXLITE_DEPS_STUB",
                "BOXLITE_BUILD_LIBKRUNFW",
                "BOXLITE_LIBKRUNFW_SOURCE",
            ]:
                env.pop(name, None)

            def build():
                return subprocess.run(
                    [str(binary)],
                    check=False,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

            def installed_proof():
                # Separate processes avoid dlopen retaining the previous dylib.
                return subprocess.check_output(
                    [
                        sys.executable,
                        "-c",
                        (
                            "import ctypes,sys; lib=ctypes.CDLL(sys.argv[1]); "
                            "lib.proof.restype=ctypes.c_char_p; "
                            "print(lib.proof().decode())"
                        ),
                        str(out / "libkrunfw/lib/libkrunfw.5.dylib"),
                    ],
                    text=True,
                ).strip()

            for selected, expected in [
                (None, "default"),
                (override, "dind"),
                (None, "default"),
            ]:
                if selected is None:
                    env.pop("BOXLITE_LIBKRUNFW_SOURCE", None)
                else:
                    env["BOXLITE_LIBKRUNFW_SOURCE"] = str(selected)
                result = build()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(installed_proof(), expected, result.stdout)
                if selected:
                    self.assertIn(
                        "cargo:rerun-if-env-changed=BOXLITE_LIBKRUNFW_SOURCE",
                        result.stdout,
                    )
                    for name in ["kernel.c", "kernel.config", "Makefile"]:
                        self.assertIn(
                            f"cargo:rerun-if-changed={selected / name}", result.stdout
                        )

            env["BOXLITE_LIBKRUNFW_SOURCE"] = str(override)
            for name in ["kernel.c", "kernel.config", "Makefile"]:
                path = override / name
                contents = path.read_text()
                path.unlink()
                result = build()
                self.assertNotEqual(result.returncode, 0, name)
                self.assertIn(name, result.stderr)
                path.write_text(contents)


if __name__ == "__main__":
    unittest.main()
