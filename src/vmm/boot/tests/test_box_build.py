#!/usr/bin/env python3
"""Exercise the BoxLite-hosted kernel build wrapper without downloading BoxLite or starting a VM."""

import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
IMAGE = "ubuntu:24.04@sha256:" + "a" * 64
TARGETS = ("aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu")

# Stands in for uname, curl and the released boxlite binary. Every call is logged
# with the environment the wrapper is responsible for setting.
TOOL = f"#!{sys.executable}\n" + r'''import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
fixture = pathlib.Path(os.environ["BOX_TEST_FIXTURE"])
env = {key: os.environ.get(key) for key in ("BOXLITE_HOME", "XDG_DATA_HOME")}
with (fixture / "calls").open("a") as stream:
    stream.write(json.dumps([name, args, env]) + "\n")
if name == "uname":
    system, machine = os.environ["BOX_TEST_HOST"].split("-")
    print(system if args == ["-s"] else machine)
elif name == "curl":
    destination = pathlib.Path(args[args.index("--output") + 1])
    if os.environ.get("BOX_TEST_MODE") == "bad-download":
        destination.write_bytes(b"tampered release")
    else:
        shutil.copyfile(fixture / "release.tar.gz", destination)
elif name == "boxlite":
    sys.exit(int(os.environ.get("BOX_TEST_EXIT", "0")))
'''


class BoxBuildContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="boxlite-box-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name)
        self.repo = self.fixture / "repo"
        self.script = self.repo / "scripts/build/build-vmm-boot-in-box.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copy(ROOT / "scripts/build/build-vmm-boot-in-box.sh", self.script)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as stream:
            entry = tarfile.TarInfo("boxlite")
            entry.size, entry.mode = len(TOOL.encode()), 0o755
            stream.addfile(entry, io.BytesIO(TOOL.encode()))
        (self.fixture / "release.tar.gz").write_bytes(archive.getvalue())
        digest = hashlib.sha256(archive.getvalue()).hexdigest()
        lock = self.repo / "src/vmm/boot/boxlite.lock"
        lock.parent.mkdir(parents=True)
        lock.write_text("BOXLITE_VERSION=9.9.9\n" + "".join(
            f"BOXLITE_SHA256_{target.replace('-', '_')}={digest}\n" for target in TARGETS)
            + f"BUILDER_IMAGE={IMAGE}\n")
        self.cache = self.repo / "target/vmm/boot/.cache"
        self.bin = self.fixture / "bin"
        self.bin.mkdir()
        for name in ("bash", "dirname", "getconf", "mkdir", "mv", "rm", "tar", "gzip", "sha256sum"):
            (self.bin / name).symlink_to(shutil.which(name))
        for name in ("uname", "curl"):
            (self.bin / name).write_text(TOOL)
            (self.bin / name).chmod(0o755)
        self.env = {"PATH": str(self.bin), "BOX_TEST_FIXTURE": str(self.fixture),
                    "BOX_TEST_HOST": "Linux-x86_64"}

    def run_box(self, *args, expected=0, **env):
        result = subprocess.run(["/bin/bash", str(self.script), "--jobs", "2", *args], cwd=self.repo,
                                env={**self.env, **env}, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self, name):
        path = self.fixture / "calls"
        lines = path.read_text().splitlines() if path.exists() else []
        return [(args, env) for tool, args, env in map(json.loads, lines) if tool == name]

    def test_builds_inside_a_pinned_box_with_isolated_state(self):
        self.run_box()
        self.run_box()
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertIn("/v9.9.9/boxlite-cli-v9.9.9-x86_64-unknown-linux-gnu.tar.gz",
                      " ".join(self.calls("curl")[0][0]))
        args, env = self.calls("boxlite")[0]
        state = self.repo / "target/vmm/boot/.boxlite"
        self.assertEqual(env, {"BOXLITE_HOME": str(state), "XDG_DATA_HOME": str(state / "xdg")})
        self.assertEqual(args[:12], ["run", "--rm", "--cpus", "2", "--memory", "4096", "--disk-size", "16",
                                     "-v", f"{self.repo}:/src", "-w", "/src"])
        self.assertEqual(args[12:15], [IMAGE, "bash", "-c"])
        self.assertIn("TMPDIR=/var/tmp/boxlite-vmm-boot", args[15])
        self.assertIn("gcc-x86-64-linux-gnu", args[15])
        self.assertIn("scripts/build/build-vmm-boot.sh", args[15])
        self.assertEqual(args[16:], ["bash", "/src/target/vmm/boot/x86_64", "2"])
        self.assertEqual(self.run_box(expected=3, BOX_TEST_EXIT="3").returncode, 3)

    def test_selects_the_release_for_each_supported_host(self):
        for host, target in (("Darwin-arm64", "aarch64-apple-darwin"),
                             ("Linux-aarch64", "aarch64-unknown-linux-gnu")):
            with self.subTest(host=host):
                self.run_box(BOX_TEST_HOST=host)
                self.assertIn(f"boxlite-cli-v9.9.9-{target}.tar.gz", " ".join(self.calls("curl")[-1][0]))
        self.assertIn("unsupported host", self.run_box(expected=1, BOX_TEST_HOST="Darwin-x86_64").stderr)

    def test_rejects_unverified_releases_and_outputs_outside_the_repository(self):
        self.assertIn("SHA256 mismatch", self.run_box(expected=1, BOX_TEST_MODE="bad-download").stderr)
        self.assertEqual(list(self.cache.iterdir()), [])
        tarball = self.cache / "boxlite-cli-v9.9.9-x86_64-unknown-linux-gnu.tar.gz"
        tarball.write_bytes(b"corrupt")
        self.assertIn("SHA256 mismatch", self.run_box(expected=1).stderr)
        for output in (str(self.fixture / "elsewhere"), "target/../../elsewhere", str(self.repo)):
            with self.subTest(output=output):
                self.assertIn("inside the repository", self.run_box("--output", output, expected=1).stderr)
        self.assertEqual(self.calls("boxlite"), [])

    def test_make_forwards_literal_output_and_jobs(self):
        (self.repo / "Makefile").write_text(f"SCRIPT_DIR := {self.repo}/scripts\ninclude {ROOT}/make/build.mk\n")
        result = subprocess.run([shutil.which("make"), "--no-print-directory", "vmm:boot",
                                 "BOOT_OUTPUT=out dir $(touch BAD)", "BOOT_JOBS=3"], cwd=self.repo,
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls("boxlite")[0][0][-3:], ["bash", "/src/out dir $(touch BAD)", "3"])
        self.assertFalse((self.repo / "BAD").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
