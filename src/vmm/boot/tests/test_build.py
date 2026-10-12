#!/usr/bin/env python3
"""Exercise the production kernel build script without downloading or compiling Linux."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
ARTIFACTS = {"vmlinux", "kernel.config", "build-info.txt", "SHA256SUMS"}

# Tool substitutes provide the external boundaries. The real script still owns
# configuration, caching, verification, metadata and publication. They run under
# this suite's interpreter, which need not be /usr/bin/python3.
TOOL = f"#!{sys.executable}\n" + r'''import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get("BOOT_TEST_MODE", "")
fixture = pathlib.Path(os.environ["BOOT_TEST_FIXTURE"])
with (fixture / "calls").open("a") as stream:
    stream.write(json.dumps([name, args]) + "\n")
if name == "uname":
    print("Darwin" if mode == "macos" and args == ["-s"] else "Linux" if args == ["-s"] else "x86_64")
elif args == ["--version"]:
    print(name + " fixture 1.0")
elif name in ("gcc", "x86_64-linux-gnu-gcc"):
    if args == ["-dumpmachine"]:
        print("x86_64-linux-gnu")
    else:
        pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"fixture probe")
elif name == "readelf":
    print("Class: ELF64\nMachine: Advanced Micro Devices X86-64\nEntry point address: "
          + ("0x200000" if mode == "wrong-entry" else "0x1000000"))
elif name == "curl":
    destination = pathlib.Path(args[args.index("--output") + 1])
    if mode == "bad-download":
        destination.write_bytes(b"incorrect tarball")
    else:
        shutil.copyfile(fixture / "source.tar.xz", destination)
elif name == "make":
    options = dict(arg.split("=", 1) for arg in args if "=" in arg)
    build = pathlib.Path(options["O"])
    if "allnoconfig" in args:
        config = pathlib.Path(options["KCONFIG_ALLCONFIG"]).read_text()
        if mode == "drop-config":
            config = config.replace("CONFIG_BLK_DEV_INITRD=y", "# CONFIG_BLK_DEV_INITRD is not set")
        # Kconfig derives the load address from the fragment's disabled RANDOMIZE_BASE.
        (build / ".config").write_text(config + "CONFIG_PHYSICAL_START=0x1000000\n")
    else:
        assert not (build / "built-once").exists(), "build directory was reused"
        (build / "built-once").touch()
        (build / "vmlinux").write_bytes(b"fixture kernel")
'''


class BootBuildContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="boxlite-boot-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name)
        self.repo = self.fixture / "repo"
        inputs = self.repo / "src/vmm/boot"
        inputs.mkdir(parents=True)
        self.script = self.repo / "scripts/build/build-vmm-boot.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copy(ROOT / "scripts/build/build-vmm-boot.sh", self.script)
        shutil.copy(ROOT / "src/vmm/boot/kernel.config", inputs / "kernel.config")
        source = self.fixture / "linux-fixture"
        source.mkdir()
        (source / "Makefile").write_text("# fixture kernel sources\n")
        archive = self.fixture / "source.tar.xz"
        with tarfile.open(archive, "w:xz") as stream:
            stream.add(source, arcname="linux-fixture")
        (inputs / "kernel.lock").write_text("KERNEL_VERSION=fixture\nSOURCE_DATE_EPOCH=1234567890\n"
                                            f"KERNEL_SHA256={hashlib.sha256(archive.read_bytes()).hexdigest()}\n")
        self.cache = self.repo / "target/vmm/boot/.cache/linux-fixture.tar.xz"
        self.output = self.repo / "target/vmm/boot/x86_64"
        self.tmp, self.bin = self.fixture / "tmp", self.fixture / "bin"
        for directory in (self.tmp, self.bin):
            directory.mkdir()
        for name in ("bash", "dirname", "getconf", "date", "mkdir", "cp", "mv", "rm", "mktemp", "install",
                     "tar", "xz", "sha256sum", "grep"):
            (self.bin / name).symlink_to(shutil.which(name))
        for name in ("gcc", "x86_64-linux-gnu-gcc", "x86_64-linux-gnu-ld", "x86_64-linux-gnu-as",
                     "make", "bc", "bison", "flex", "curl", "perl", "readelf", "uname"):
            (self.bin / name).write_text(TOOL)
            (self.bin / name).chmod(0o755)
        self.env = {"PATH": str(self.bin), "TMPDIR": str(self.tmp), "BOOT_TEST_FIXTURE": str(self.fixture)}

    def run_build(self, *args, mode="", expected=0):
        result = subprocess.run(["/bin/bash", str(self.script), "--jobs", "2", *args], cwd=self.repo,
                                env={**self.env, "BOOT_TEST_MODE": mode}, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self, name):
        return [args for tool, args in map(json.loads, (self.fixture / "calls").read_text().splitlines())
                if tool == name]

    def outputs(self):
        return {path.name: path.read_bytes() for path in self.output.iterdir()}

    def test_fresh_builds_publish_verified_artifacts_from_the_cached_source(self):
        self.run_build()
        first = self.outputs()
        self.assertEqual(first.keys(), ARTIFACTS)
        self.assertEqual(first["vmlinux"], b"fixture kernel")
        self.assertNotIn(str(self.fixture).encode(), first["build-info.txt"])
        for line in first["SHA256SUMS"].decode().splitlines():
            digest, name = line.split()
            self.assertEqual(digest, hashlib.sha256(first[name]).hexdigest())
        self.run_build()
        self.assertEqual(first, self.outputs())
        self.assertEqual(len(self.calls("curl")), 1)
        builds = {args[2] for args in self.calls("make") if args[-1] == "vmlinux"}
        self.assertEqual(len(builds), 2)
        for build in builds:
            self.assertEqual(Path(build[2:]).parent.parent, self.tmp)
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_rejected_hosts_sources_and_kernels_publish_nothing(self):
        for mode, message in (("macos", "Linux host required"),
                              ("bad-download", "SHA256 mismatch"),
                              ("drop-config", "did not retain CONFIG_BLK_DEV_INITRD=y"),
                              ("wrong-entry", "unexpected kernel entry 0x200000")):
            with self.subTest(mode=mode):
                self.assertIn(message, self.run_build(mode=mode, expected=1).stderr)
                self.assertFalse(self.output.exists())
                self.assertEqual(list(self.tmp.iterdir()), [])
                self.assertEqual(self.cache.exists(), mode not in ("macos", "bad-download"))
        self.assertIn("positive integer", self.run_build("--jobs", "0", expected=1).stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
