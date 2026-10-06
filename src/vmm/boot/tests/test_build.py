#!/usr/bin/env python3
"""Exercise the production boot builder without downloading or compiling Linux."""

import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
ARTIFACTS = {
    "vmlinux", "bzImage", "test-initramfs.cpio", "kernel.config",
    "build-info.txt", "SHA256SUMS",
}

# Tool substitutes provide the external boundaries. The real script still owns
# configuration, caching, process lifetime, manifests, metadata and publication.
TOOL = r'''#!/usr/bin/python3
import json, os, pathlib, shutil, signal, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get("BOOT_TEST_MODE", "")
fixture = pathlib.Path(os.environ["BOOT_TEST_FIXTURE"])
with (fixture / "calls").open("a") as stream:
    stream.write(json.dumps([name, args]) + "\n")
if name == "uname":
    print("Darwin" if mode == "macos" and args == ["-s"] else
          "Linux" if args == ["-s"] else "x86_64")
elif args == ["--version"]:
    print(name + " fixture 1.0")
elif name in ("gcc", "x86_64-linux-gnu-gcc"):
    if args == ["-dumpmachine"]:
        print("aarch64-linux-gnu" if mode == "wrong-target" else "x86_64-linux-gnu")
    elif args == ["-print-file-name=libc.a"]:
        print("libc.a" if mode == "missing-libc" else fixture / "libc.a")
    else:
        if mode == "compile-fail":
            sys.exit("fixture compiler failure")
        if mode == "init-compile-fail" and name == "x86_64-linux-gnu-gcc":
            sys.exit("fixture static init compilation failure")
        pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"fixture static init")
elif name == "readelf":
    if mode == "readelf-fail":
        sys.exit("fixture readelf failure")
    if args[0] == "-hW":
        print("ELF64 AArch64" if mode == "wrong-elf" else
              "Class: ELF64\nMachine: Advanced Micro Devices X86-64")
    elif args[0] == "-lW":
        print("INTERP" if mode == "dynamic-init" else "LOAD")
    elif args[0] == "-dW":
        print("NEEDED" if mode == "needed-init" else "No dynamic section")
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
        (build / ".config").write_text(config)
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
        (build / "arch/x86/boot").mkdir(parents=True)
        (build / "arch/x86/boot/bzImage").write_bytes(b"fixture bzImage")
        (build / "usr").mkdir()
        source = pathlib.Path(args[args.index("-C") + 1])
        shutil.copy(source / "gen_init_cpio", build / "usr/gen_init_cpio")
'''

CPIO = '''#!/usr/bin/python3
import pathlib, sys
print("timestamp=" + sys.argv[2])
print(pathlib.Path(sys.argv[3]).read_text(), end="")
sys.stdout.flush()
sys.stdout.buffer.write(pathlib.Path("init").read_bytes())
'''


class BootBuildContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="boxlite-boot-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name)
        self.repo = self.fixture / "repo"
        self.inputs = self.repo / "src/vmm/boot"
        self.inputs.mkdir(parents=True)
        self.script = self.repo / "scripts/build/build-vmm-boot.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copy(ROOT / "scripts/build/build-vmm-boot.sh", self.script)
        for name in ("init.c", "kernel.config"):
            shutil.copy(ROOT / "src/vmm/boot" / name, self.inputs / name)
        source = self.fixture / "linux-fixture"
        source.mkdir()
        (source / "gen_init_cpio").write_text(CPIO)
        (source / "gen_init_cpio").chmod(0o755)
        archive = self.fixture / "source.tar.xz"
        with tarfile.open(archive, "w:xz") as stream:
            stream.add(source, arcname="linux-fixture")
        self.digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.inputs / "kernel.lock").write_text(
            f"KERNEL_VERSION=fixture\nKERNEL_SHA256={self.digest}\nSOURCE_DATE_EPOCH=1234567890\n"
        )
        self.cache = self.repo / "target/vmm/boot/.cache/linux-fixture.tar.xz"
        self.output = self.repo / "target/vmm/boot/x86_64"
        (self.fixture / "libc.a").write_bytes(b"fixture libc")
        self.bin = self.fixture / "bin"
        self.bin.mkdir()
        for name in ("bash", "dirname", "realpath", "getconf", "date", "mkdir", "cp",
                     "mv", "rm", "mktemp", "install", "tar", "xz", "sha256sum",
                     "grep", "flock", "setsid"):
            (self.bin / name).symlink_to(shutil.which(name))
        for name in ("gcc", "x86_64-linux-gnu-gcc", "x86_64-linux-gnu-ld",
                     "x86_64-linux-gnu-as", "make", "bc", "bison", "flex", "curl",
                     "perl", "readelf", "uname"):
            (self.bin / name).write_text(TOOL)
            (self.bin / name).chmod(0o755)
        self.env = {"PATH": str(self.bin), "BOOT_TEST_FIXTURE": str(self.fixture)}

    def run_build(self, *args, mode="", expected=0):
        result = subprocess.run(
            ["/bin/bash", str(self.script), "--jobs", "2", *args],
            cwd=self.repo, env={**self.env, "BOOT_TEST_MODE": mode},
            text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self, name):
        return [args for tool, args in map(json.loads, (self.fixture / "calls").read_text().splitlines())
                if tool == name]

    def test_arguments_and_help(self):
        self.assertIn("--output", self.run_build("--help").stdout)
        for args, message in ((["--jobs", "0"], "positive integer"),
                              (["--jobs", "-1"], "positive integer"),
                              (["--jobs", "1.5"], "positive integer"),
                              (["--jobs"], "missing value"),
                              (["--output"], "missing value"),
                              (["--rebuild"], "unknown argument")):
            with self.subTest(args=args):
                self.assertIn(message, self.run_build(*args, expected=1).stderr)
        self.assertFalse(self.cache.exists())

    def test_host_dependencies_and_static_init_checks(self):
        for mode, message in (("macos", "Linux host required"),
                              ("wrong-target", "must target x86_64"),
                              ("missing-libc", "static x86_64 libc missing"),
                              ("wrong-elf", "expected x86_64 ELF64"),
                              ("dynamic-init", "statically linked"),
                              ("needed-init", "statically linked"),
                              ("readelf-fail", "fixture readelf failure"),
                              ("init-compile-fail", "static init compilation failure"),
                              ("compile-fail", "host headers missing")):
            with self.subTest(mode=mode):
                self.assertIn(message, self.run_build(mode=mode, expected=1).stderr)
                self.assertFalse(self.cache.exists())
        (self.bin / "flex").unlink()
        self.assertIn("missing flex", self.run_build(expected=1).stderr)

    def test_clean_rebuild_uses_verified_source_cache(self):
        self.run_build()
        first = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.assertEqual(first.keys(), ARTIFACTS)
        self.assertIn(b"nod /dev/console 0600 0 0 c 5 1", first["test-initramfs.cpio"])
        self.assertIn(b"file /init init 0755 0 0", first["test-initramfs.cpio"])
        self.assertIn(b"timestamp=1234567890", first["test-initramfs.cpio"])
        self.assertNotIn(str(self.fixture).encode(), first["build-info.txt"])
        for line in first["SHA256SUMS"].decode().splitlines():
            digest, name = line.split()
            self.assertEqual(digest, hashlib.sha256(first[name]).hexdigest())
        self.run_build()
        self.assertEqual(first, {path.name: path.read_bytes() for path in self.output.iterdir()})
        self.assertEqual(len(self.calls("curl")), 1)
        compile_calls = [args for args in self.calls("make") if "bzImage" in args]
        builds = [next(arg[2:] for arg in args if arg.startswith("O=")) for args in compile_calls]
        self.assertEqual(len(set(builds)), 2)
        for build in builds:
            self.assertFalse(Path(build).parent.exists())
        self.assertIn("--max-time", self.calls("curl")[0])

    def test_rejects_corrupt_cache_without_downloading(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_bytes(b"corrupt")
        self.assertIn("SHA256 mismatch", self.run_build(expected=1).stderr)
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.calls("make"), [])
        self.assertFalse(self.output.exists())

    def test_failed_download_never_enters_cache(self):
        self.assertIn("SHA256 mismatch", self.run_build(mode="bad-download", expected=1).stderr)
        self.assertFalse(self.cache.exists())
        self.run_build(mode="download-fail", expected=22)
        self.assertFalse(self.cache.exists())

    def test_config_and_build_failure_preserve_previous_outputs(self):
        self.run_build()
        original = {path.name: path.read_bytes() for path in self.output.iterdir()}
        for mode, message in (("drop-config", "did not retain CONFIG_BLK_DEV_INITRD=y"),
                              ("enable-forbidden", "forbidden setting CONFIG_PCI"),
                              ("kernel-fail", "kernel compilation failure")):
            with self.subTest(mode=mode):
                self.assertIn(message, self.run_build(mode=mode, expected=1).stderr)
                self.assertEqual(original, {path.name: path.read_bytes() for path in self.output.iterdir()})
        for args in self.calls("make"):
            if "allnoconfig" not in args and "bzImage" not in args:
                continue
            build = next(arg[2:] for arg in args if arg.startswith("O="))
            self.assertFalse(Path(build).parent.exists())

    def test_publication_failure_restores_previous_directory(self):
        self.run_build()
        original = {path.name: path.read_bytes() for path in self.output.iterdir()}
        move = self.bin / "mv"
        move.unlink()
        move.write_text(TOOL)
        move.chmod(0o755)
        self.assertIn("publication failure", self.run_build(mode="publish-fail", expected=1).stderr)
        self.assertEqual(original, {path.name: path.read_bytes() for path in self.output.iterdir()})
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
        (destination / "vmlinux").symlink_to(self.fixture / "libc.a")
        self.assertIn("unsafe output entry", self.run_build("--output", str(destination), expected=1).stderr)

    def test_make_forwards_literal_output_and_jobs(self):
        makefile = self.repo / "Makefile"
        makefile.write_text(f'SCRIPT_DIR := {self.repo}/scripts\ninclude {ROOT}/make/build.mk\n')
        name = "artifacts with spaces 'quote' $(touch SHOULD_NOT_EXIST) `touch ALSO_BAD`"
        result = subprocess.run(
            [shutil.which("make"), "--no-print-directory", "vmm:boot", f"BOOT_OUTPUT={name}", "BOOT_JOBS=3"],
            cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({p.name for p in (self.repo / name).iterdir()}, ARTIFACTS)
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())
        self.assertFalse((self.repo / "ALSO_BAD").exists())
        self.assertTrue(any("-j3" in args for args in self.calls("make")))

    def test_cancellation_stops_children_and_releases_lock(self):
        process = subprocess.Popen(
            ["/bin/bash", str(self.script)], cwd=self.repo,
            env={**self.env, "BOOT_TEST_MODE": "hang"},
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
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
                self.assertIn("another VMM boot build", self.run_build(expected=1).stderr)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143, stdout + stderr)
                self.assertTrue(selector.select(5), "compiler child survived cancellation")
            finally:
                os.close(child_fd)
        self.assertFalse(Path(work).exists())
        self.run_build()


if __name__ == "__main__":
    unittest.main(verbosity=2)
