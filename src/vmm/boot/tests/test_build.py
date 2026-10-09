#!/usr/bin/env python3
"""Exercise the production kernel build script without downloading or compiling Linux.

Set BOOT_REAL_BUILD=1 to also build the real kernel twice and compare the outputs.
"""

import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "scripts/build/build-vmm-boot.sh"
ARTIFACTS = {"vmlinux", "kernel.config", "build-info.txt", "SHA256SUMS"}

# Tool substitutes provide the external boundaries. The real script still owns
# configuration, caching, verification, metadata and publication. They run under
# this suite's interpreter, which need not be /usr/bin/python3.
TOOL = f"#!{sys.executable}\n" + r'''import json, os, pathlib, shutil, signal, subprocess, sys
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
        print("aarch64-linux-gnu" if mode == "wrong-target" else "x86_64-linux-gnu")
    elif mode == "compile-fail":
        sys.exit("fixture compiler failure")
    else:
        pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"fixture probe")
elif name == "readelf":
    if mode == "readelf-fail":
        sys.exit("fixture readelf failure")
    print("ELF64 AArch64" if mode == "wrong-elf" else
          "Class: ELF64\nMachine: Advanced Micro Devices X86-64\nEntry point address: "
          + ("0x200000" if mode == "wrong-entry" else "0x1000000"))
elif name == "curl":
    destination = pathlib.Path(args[args.index("--output") + 1])
    if mode == "download-fail":
        destination.write_bytes(b"partial download")
        sys.exit(22)
    if mode == "bad-download":
        destination.write_bytes(b"incorrect tarball")
    else:
        shutil.copyfile(fixture / "source.tar.xz", destination)
elif name == "mv":
    if mode == "publish-fail" and pathlib.Path(args[-2]).name.startswith(".boxlite-boot."):
        sys.exit("fixture publication failure")
    os.execv("/bin/mv", ["mv", *args])
elif name == "make":
    options = dict(arg.split("=", 1) for arg in args if "=" in arg)
    build = pathlib.Path(options["O"])
    if "allnoconfig" in args:
        config = pathlib.Path(options["KCONFIG_ALLCONFIG"]).read_text()
        if mode == "drop-config":
            config = config.replace("CONFIG_BLK_DEV_INITRD=y", "# CONFIG_BLK_DEV_INITRD is not set")
        if mode == "enable-forbidden":
            config = config.replace("# CONFIG_PCI is not set", "CONFIG_PCI=y")
        # Kconfig derives the load address from the fragment's disabled RANDOMIZE_BASE.
        (build / ".config").write_text(config + "CONFIG_PHYSICAL_START=0x1000000\n")
    else:
        if mode == "kernel-fail":
            sys.exit("fixture kernel compilation failure")
        if mode == "hang":
            child = subprocess.Popen([sys.executable, "-c", "import signal; signal.pause()"])
            print("BLOCKED " + str(child.pid) + " " + str(build.parent), flush=True)
            signal.pause()
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
        shutil.copy(SCRIPT, self.script)
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
                     "tar", "xz", "sha256sum", "grep", "chmod", "realpath", "flock", "setsid"):
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
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o755)
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
        before_cache = ("macos", "wrong-target", "compile-fail", "bad-download")
        for mode, message in (("macos", "Linux host required"),
                              ("wrong-target", "must target x86_64"),
                              ("compile-fail", "libelf development files missing"),
                              ("bad-download", "SHA256 mismatch"),
                              ("drop-config", "did not retain CONFIG_BLK_DEV_INITRD=y"),
                              ("enable-forbidden", "forbidden setting CONFIG_PCI"),
                              ("wrong-elf", "expected x86_64 ELF64"),
                              ("wrong-entry", "unexpected kernel entry 0x200000"),
                              ("readelf-fail", "fixture readelf failure")):
            with self.subTest(mode=mode):
                self.assertIn(message, self.run_build(mode=mode, expected=1).stderr)
                self.assertFalse(self.output.exists())
                self.assertEqual(list(self.tmp.iterdir()), [])
                self.assertEqual(self.cache.exists(), mode not in before_cache)
        (self.bin / "flex").unlink()
        self.assertIn("missing flex", self.run_build(expected=1).stderr)
        for args, message in ((["--jobs", "0"], "positive integer"),
                              (["--jobs", "1.5"], "positive integer"),
                              (["--jobs"], "missing value"),
                              (["--output"], "missing value"),
                              (["--rebuild"], "unknown argument")):
            with self.subTest(args=args):
                self.assertIn(message, self.run_build(*args, expected=1).stderr)
        self.assertIn("--output", self.run_build("--help").stdout)

    def test_rejects_corrupt_cache_without_downloading(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_bytes(b"corrupt")
        self.assertIn("SHA256 mismatch", self.run_build(expected=1).stderr)
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.calls("make"), [])
        self.assertFalse(self.output.exists())

    def test_failed_download_leaves_only_the_lock_in_the_cache(self):
        self.run_build(mode="download-fail", expected=22)
        self.assertEqual([path.name for path in self.cache.parent.iterdir()], ["build.lock"])

    def test_build_and_publication_failures_restore_previous_outputs(self):
        self.run_build()
        original = self.outputs()
        self.assertIn("kernel compilation failure", self.run_build(mode="kernel-fail", expected=1).stderr)
        self.assertEqual(original, self.outputs())
        move = self.bin / "mv"
        move.unlink()
        move.write_text(TOOL)
        move.chmod(0o755)
        self.assertIn("publication failure", self.run_build(mode="publish-fail", expected=1).stderr)
        self.assertEqual(original, self.outputs())
        self.assertEqual(list(self.output.parent.glob(".boxlite-boot*")), [])

    def test_protects_unrelated_output_and_symlinks(self):
        destination = self.fixture / "user-files"
        destination.mkdir()
        (destination / "keep").write_text("user content")
        self.assertIn("unrelated entry", self.run_build("--output", str(destination), expected=1).stderr)
        self.assertEqual((destination / "keep").read_text(), "user content")
        link = self.fixture / "link"
        link.symlink_to(destination)
        self.assertIn("symlink", self.run_build("--output", str(link), expected=1).stderr)
        (destination / "keep").unlink()
        (destination / "vmlinux").symlink_to(self.fixture / "source.tar.xz")
        self.assertIn("unsafe output entry", self.run_build("--output", str(destination), expected=1).stderr)
        self.assertIn("not a directory", self.run_build("--output", str(self.fixture / "source.tar.xz"), expected=1).stderr)
        self.assertEqual(self.calls("make"), [])

    def test_make_forwards_literal_output_and_jobs(self):
        (self.repo / "Makefile").write_text(f"SCRIPT_DIR := {self.repo}/scripts\ninclude {ROOT}/make/build.mk\n")
        name = "artifacts with spaces 'quote' $(touch SHOULD_NOT_EXIST) `touch ALSO_BAD`"
        result = subprocess.run([shutil.which("make"), "--no-print-directory", "vmm:boot", f"BOOT_OUTPUT={name}",
                                 "BOOT_JOBS=3"], cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({p.name for p in (self.repo / name).iterdir()}, ARTIFACTS)
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())
        self.assertFalse((self.repo / "ALSO_BAD").exists())
        self.assertTrue(any("-j3" in args for args in self.calls("make")))

    def test_cancellation_stops_children_and_releases_lock(self):
        process = subprocess.Popen(["/bin/bash", str(self.script)], cwd=self.repo,
                                   env={**self.env, "BOOT_TEST_MODE": "hang"},
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(15), "build never reached blocking compiler")
            event, pid, work = process.stdout.readline().strip().split()
            self.assertEqual(event, "BLOCKED")
            child_fd = os.pidfd_open(int(pid))
            try:
                selector.unregister(process.stdout)
                selector.register(child_fd, selectors.EVENT_READ)
                descriptors = []
                for entry in Path(f"/proc/{pid}/fd").iterdir():
                    try:  # The child may close startup descriptors while they are listed.
                        descriptors.append(os.readlink(entry))
                    except FileNotFoundError:
                        pass
                self.assertFalse(any(target.endswith("build.lock") for target in descriptors), descriptors)
                self.assertIn("another VMM boot build", self.run_build(expected=1).stderr)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143, stdout + stderr)
                self.assertTrue(selector.select(5), "compiler child survived cancellation")
            finally:
                os.close(child_fd)
        self.assertFalse(Path(work).exists())
        self.run_build()


@unittest.skipUnless(os.environ.get("BOOT_REAL_BUILD") == "1",
                     "set BOOT_REAL_BUILD=1 to build the real kernel twice")
class RealBuild(unittest.TestCase):
    def test_two_native_builds_are_identical_and_loadable(self):
        with tempfile.TemporaryDirectory(prefix="boxlite-boot-real-") as temporary:
            outputs = [Path(temporary, name) for name in ("a", "b")]
            for output in outputs:
                subprocess.run(["/bin/bash", str(SCRIPT), "--output", str(output)],
                               cwd=ROOT, check=True, timeout=3600)
            first, second = ({path.name: path.read_bytes() for path in output.iterdir()}
                             for output in outputs)
            self.assertEqual(first.keys(), ARTIFACTS)
            self.assertEqual(first, second)
            vmlinux = outputs[0] / "vmlinux"
            header = subprocess.run(["readelf", "-hW", vmlinux], check=True, text=True,
                                    capture_output=True).stdout
            for expected in ("ELF64", "EXEC", "Advanced Micro Devices X86-64", "0x1000000"):
                self.assertIn(expected, header)
            segments = subprocess.run(["readelf", "-lW", vmlinux], check=True, text=True,
                                      capture_output=True).stdout
            loads = [line.split() for line in segments.splitlines() if line.strip().startswith("LOAD")]
            self.assertTrue(loads)
            for fields in loads:
                self.assertGreaterEqual(int(fields[3], 16), 0x100000, fields)
            config = first["kernel.config"].decode()
            for setting in ("CONFIG_PHYSICAL_START=0x1000000", "CONFIG_BLK_DEV_INITRD=y",
                            "# CONFIG_RELOCATABLE is not set"):
                self.assertIn(setting + "\n", config)


if __name__ == "__main__":
    unittest.main(verbosity=2)
