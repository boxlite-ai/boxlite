"""Exercise the public matrix Make targets with a stubbed VM test runner."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]


class VmmMatrixTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        scripts = self.root / "scripts/test"
        scripts.mkdir(parents=True)
        shutil.copyfile(REPO / "scripts/test/vmm-matrix.sh", scripts / "vmm-matrix.sh")
        (self.root / "Makefile").write_text(
            f"PROJECT_ROOT := {self.root}\nSCRIPT_DIR := {self.root}/scripts\n"
            "SETUP_DONE := 1\n"
            f"include {REPO}/make/test.mk\n"
            "_ensure-kvm _ensure-vmm-kernel:\n\t@true\n"
        )
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
             "commit", "-qm", "fixture"], cwd=self.root, check=True,
        )
        tests = self.root / "src/boxlite/tests"
        tests.mkdir(parents=True)
        (tests / "untracked.rs").write_text("// retained test input\n")
        runtime = self.root / "custom runtime"
        runtime.mkdir()
        for name in ("boxlite-shim", "boxlite-guest", "libkrunfw.so.5"):
            (runtime / name).write_text(name)
        kernel = self.root / "custom kernel"
        kernel.write_text("kernel")
        tools = self.root / "bin"
        tools.mkdir()
        cargo = tools / "cargo"
        cargo.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "with open(os.environ['MATRIX_CALLS'], 'a') as log:\n"
            "    log.write(json.dumps({'args': sys.argv[1:], 'env': {key: os.environ.get(key) "
            "for key in ['BOXLITE_TEST_ENGINE', 'BOXLITE_TEST_REQUIRE_EGRESS', "
            "'BOXLITE_RUNTIME_DIR', 'VMM_KERNEL']}}) + '\\n')\n"
            "if sys.argv[2] == 'list':\n"
            "    print(json.dumps({'test-count': 1}))\n"
            "    sys.exit(int(os.environ.get('MATRIX_LIST_STATUS', '0')))\n"
            "print('guest result retained')\n"
            "sys.exit(int(os.environ.get('MATRIX_RUN_STATUS', '0')))\n"
        )
        cargo.chmod(0o755)
        self.calls = self.root / "calls.jsonl"
        self.env = {
            **os.environ,
            "PATH": str(tools) + os.pathsep + os.environ["PATH"],
            "MATRIX_CALLS": str(self.calls),
            "BOXLITE_RUNTIME_DIR": str(runtime),
            "VMM_KERNEL": str(kernel),
        }
        for key in ("MAKEFLAGS", "MFLAGS", "MAKELEVEL", "FILTER", "NEXTEST_FILTER_EXPR"):
            self.env.pop(key, None)

    def run_matrix(self, matrix="m2", engine="native", **env):
        report = self.root / f"{matrix}-{engine}"
        result = subprocess.run(
            ["make", f"test:integration:vmm:{matrix}", f"ENGINE={engine}"],
            cwd=self.root,
            env={**self.env, "VMM_REPORT_DIR": str(report), **env},
            capture_output=True, text=True, timeout=15,
        )
        return result, report

    def test_both_matrices_select_the_engine_and_preserve_custom_artifacts(self):
        for matrix in ("m2", "m3"):
            for engine in ("native", "krun"):
                with self.subTest(matrix=matrix, engine=engine):
                    result, report = self.run_matrix(matrix, engine)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    calls = [json.loads(line) for line in self.calls.read_text().splitlines()][-2:]
                    self.assertEqual([call["args"][1] for call in calls], ["list", "run"])
                    for call in calls:
                        self.assertEqual(call["env"]["BOXLITE_TEST_ENGINE"], engine)
                        self.assertEqual(call["env"]["BOXLITE_TEST_REQUIRE_EGRESS"], "1")
                        for key in ("BOXLITE_RUNTIME_DIR", "VMM_KERNEL"):
                            self.assertEqual(call["env"][key], self.env[key])
                        self.assertIn("volume_matrix" if matrix == "m3" else "lifecycle", call["args"])
                        self.assertIn("all", call["args"])
                    self.assertIn("--retries", calls[1]["args"])
                    self.assertIn("--no-fail-fast", calls[1]["args"])
                    self.assertEqual(json.loads((report / "selected-tests.json").read_text())["test-count"], 1)
                    self.assertIn("exit_status=0", (report / "result.txt").read_text())
                    self.assertIn("libkrunfw.so.5", (report / "artifacts.sha256").read_text())
                    with tarfile.open(report / "untracked-inputs.tar") as archive:
                        self.assertEqual(archive.extractfile("src/boxlite/tests/untracked.rs").read(), b"// retained test input\n")

    def test_failures_survive_tee_and_report_directories_cannot_be_reused(self):
        result, report = self.run_matrix(MATRIX_RUN_STATUS="17")
        self.assertNotEqual(result.returncode, 0)
        recorded = (report / "result.txt").read_text()
        self.assertIn("stage=run", recorded)
        self.assertNotIn("exit_status=0", recorded)
        self.assertIn("guest result retained", (report / "tests.log").read_text())
        again, _ = self.run_matrix()
        self.assertNotEqual(again.returncode, 0)
        self.assertIn("must be empty", again.stderr)
        self.assertEqual((report / "result.txt").read_text(), recorded)
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_listing_failure_never_runs_tests(self):
        result, report = self.run_matrix(MATRIX_LIST_STATUS="19")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stage=list", (report / "result.txt").read_text())
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertFalse((report / "tests.log").exists())

    def test_invalid_engine_fails_before_running_or_creating_a_report(self):
        result, report = self.run_matrix(engine="invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ENGINE must be native or krun", result.stderr)
        self.assertFalse(report.exists())
        self.assertFalse(self.calls.exists())
