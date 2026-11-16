"""Exercise CLI Make recipes across Cargo's artifact/environment boundary."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

CARGO = r'''#!/usr/bin/env python3
import json, os, shlex, sys
from pathlib import Path

root = Path(os.environ["CLI_MAKE_ROOT"])
args = sys.argv[1:]
mode = os.environ.get("CLI_ARTIFACT_MODE", "valid")
binary = root / "arbitrary outputs" / "the CLI"
env_keys = ("CARGO_BIN_EXE_boxlite", "CARGO_TARGET_DIR", "CARGO_BUILD_BUILD_DIR",
            "CARGO_LLVM_COV_TARGET_DIR", "CARGO_LLVM_COV_BUILD_DIR",
            "RUSTFLAGS", "LLVM_PROFILE_FILE", "CARGO_LLVM_COV")
entry = {"args": args, "env": {key: os.environ.get(key) for key in env_keys}}
if args[0] == "build":
    entry["artifact"] = str(binary)
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(entry) + "\n")

if args[0] == "metadata":
    if mode == "metadata-failure":
        sys.exit(24)
    metadata = {"target_directory": str(root / "normal target")}
    if not os.environ.get("CLI_OLD_METADATA"):
        metadata["build_directory"] = str(root / "normal build")
    print(json.dumps(metadata))
elif args[:2] == ["llvm-cov", "show-env"]:
    if mode == "show-env-failure":
        sys.exit(25)
    # Upstream show-env overwrites these with ordinary metadata directories.
    for key, value in {
        "CARGO_LLVM_COV_TARGET_DIR": str(root / "normal target"),
        "CARGO_LLVM_COV_BUILD_DIR": str(root / "normal build"),
        "RUSTFLAGS": "-C instrument-coverage", "CARGO_LLVM_COV": "1",
        "LLVM_PROFILE_FILE": str(root / "profiles" / "%p-%m.profraw"),
    }.items():
        print("export " + key + "=" + shlex.quote(value))
elif args[0] == "build":
    binary.parent.mkdir(exist_ok=True)
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o644 if mode == "non-executable" else 0o755)
    artifact = {"reason": "compiler-artifact", "target": {"name": "boxlite", "kind": ["bin"]},
                "profile": {"test": False}, "executable": str(binary),
                "fresh": os.environ.get("CLI_FRESH") == "1"}
    # Ignore unrelated libraries and test harnesses, even with the same name.
    print(json.dumps({**artifact, "target": {"name": "boxlite", "kind": ["lib"]}}))
    print(json.dumps({**artifact, "profile": {"test": True}}))
    if mode == "relative":
        artifact["executable"] = "relative/boxlite"
    if mode == "null":
        artifact["executable"] = None
    if mode != "missing":
        print(json.dumps(artifact))
    if mode == "duplicate":
        print(json.dumps(artifact))
    if mode == "malformed":
        print("not JSON")
    print(json.dumps({"reason": "build-finished", "success": True}))
    print("cargo diagnostic on stderr", file=sys.stderr)
    if mode == "build-failure":
        sys.exit(23)
elif "boxlite-cli" in args:
    print("test stdout")
    print("test stderr", file=sys.stderr)
    sys.exit(int(os.environ.get("CLI_TEST_EXIT", "0")))
'''


class CliBinaryMakeTest(unittest.TestCase):
    def setUp(self):
        self.scratch = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.scratch).resolve() / "workspace with spaces"
        self.root.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        cargo = self.bin / "cargo"
        cargo.write_text(CARGO)
        cargo.chmod(0o755)
        (self.bin / "python3").symlink_to(sys.executable)
        jq = shutil.which("jq")
        self.assertIsNotNone(jq, "jq is required for CLI binary tests")
        (self.bin / "jq").symlink_to(Path(jq).resolve())
        self.temp = self.root / "temporary files"
        self.temp.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CARGO_", "RUST", "LLVM_", "MAKE"))}
        self.env.update(PATH=f"{self.bin}:/usr/bin:/bin", CLI_MAKE_ROOT=str(self.root),
                        TMPDIR=str(self.temp))
        (self.root / "Makefile").write_text(
            "SHELL := /bin/bash\n"
            f"SCRIPT_DIR := {ROOT / 'scripts'}\n"
            f"include {ROOT / 'make/test.mk'}\n"
            f"include {ROOT / 'make/coverage.mk'}\n"
        )

    def run_make(self, target="test:unit:cli", *variables):
        log = self.root / "calls.jsonl"
        log.unlink(missing_ok=True)
        result = subprocess.run(
            [shutil.which("make"), "--no-print-directory", target, *variables],
            cwd=self.root, env=self.env, capture_output=True, text=True, timeout=30,
        )
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    def cli_tests(self, calls):
        return [call for call in calls if "boxlite-cli" in call["args"]
                and call["args"][0] != "build"]

    def assert_cli_path(self, calls):
        tests = self.cli_tests(calls)
        self.assertEqual(len(tests), 1, calls)
        self.assertEqual(tests[0]["env"]["CARGO_BIN_EXE_boxlite"],
                         str(self.root / "arbitrary outputs/the CLI"),
                         "CLI executable path was not passed to the test command")
        return tests[0]

    def test_unit_runners_receive_artifact_including_cache_hits(self):
        for nextest in (False, True):
            for fresh in (False, True):
                with self.subTest(nextest=nextest, fresh=fresh):
                    if nextest:
                        (self.bin / "cargo-nextest").touch(exist_ok=True)
                        (self.bin / "cargo-nextest").chmod(0o755)
                    self.env["CLI_FRESH"] = str(int(fresh))
                    result, calls = self.run_make("test:unit:cli", "NEXTEST_PROFILE=ci")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    test = self.assert_cli_path(calls)
                    expected = (["nextest", "run", "-p", "boxlite-cli", "--profile", "ci",
                                 "-E", "test(::tests::)"] if nextest else
                                ["test", "-p", "boxlite-cli", "--bins", "--",
                                 "--test-threads=1", "::tests::"])
                    self.assertEqual(test["args"], expected)
                    build = next(call for call in calls if call["args"][0] == "build")
                    self.assertIn("--message-format=json-render-diagnostics", build["args"])
                    self.assertIsNone(build["env"]["RUSTFLAGS"])
                    self.assertIn("cargo diagnostic on stderr", result.stderr)
                    self.assertEqual(list(self.temp.iterdir()), [])

    def test_aggregate_coverage_passes_cli_path_and_preserves_selection(self):
        result, calls = self.run_make("coverage:lcov", "FILTER=ssh with spaces", "NEXTEST_PROFILE=ci")
        self.assertEqual(result.returncode, 0, result.stderr)
        test = self.assert_cli_path(calls)
        self.assertEqual(test["args"], [
            "llvm-cov", "nextest", "--no-report", "--no-tests=fail", "--profile", "ci",
            "-p", "boxlite-cli", "--bins", "--test", "auth", "--test", "ssh_cloud",
            "--test", "custom_kernel_rc", "--test", "checkpoint", "-E",
            "test(~ssh with spaces)", "--", "--skip", "::vm_install::",
        ])
        self.assert_coverage_environment(calls, self.root / "normal target/llvm-cov-target",
                                         self.root / "normal build/llvm-cov-target")

    def assert_coverage_environment(self, calls, target, build_dir):
        build = next(call for call in calls if call["args"][0] == "build")
        self.assertEqual(build["env"]["CARGO_TARGET_DIR"], str(target))
        self.assertEqual(build["env"]["CARGO_BUILD_BUILD_DIR"], str(build_dir))
        self.assertEqual(build["env"]["RUSTFLAGS"], "-C instrument-coverage")
        self.assertTrue(build["env"]["LLVM_PROFILE_FILE"])
        test = self.assert_cli_path(calls)
        for key in ("RUSTFLAGS", "LLVM_PROFILE_FILE", "CARGO_LLVM_COV"):
            self.assertIsNone(test["env"][key], key)
        self.assertEqual(test["env"]["CARGO_LLVM_COV_TARGET_DIR"], str(target))
        self.assertEqual(test["env"]["CARGO_LLVM_COV_BUILD_DIR"], str(build_dir))
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_coverage_directories_match_collector_overrides_and_old_metadata(self):
        for override in (False, True):
            for separate_build in (False, True):
                with self.subTest(override=override, separate_build=separate_build):
                    self.env.pop("CARGO_LLVM_COV_TARGET_DIR", None)
                    self.env.pop("CARGO_LLVM_COV_BUILD_DIR", None)
                    self.env["CLI_OLD_METADATA"] = "" if separate_build else "1"
                    if override:
                        target = self.root / "chosen target"
                        build = self.root / "chosen build" if separate_build else target
                        self.env["CARGO_LLVM_COV_TARGET_DIR"] = str(target)
                        if separate_build:
                            self.env["CARGO_LLVM_COV_BUILD_DIR"] = str(build)
                    else:
                        target = self.root / "normal target/llvm-cov-target"
                        build = self.root / "normal build/llvm-cov-target" if separate_build else target
                    result, calls = self.run_make("coverage:lcov")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assert_cli_path(calls)
                    self.assert_coverage_environment(calls, target, build)

    def test_build_or_artifact_failure_never_starts_tests(self):
        for mode in ("build-failure", "missing", "duplicate", "malformed", "relative", "null", "non-executable"):
            with self.subTest(mode=mode):
                self.env["CLI_ARTIFACT_MODE"] = mode
                result, calls = self.run_make()
                self.assertNotEqual(result.returncode, 0, mode)
                self.assertEqual(self.cli_tests(calls), [], mode)
                self.assertEqual(list(self.temp.iterdir()), [])
                if mode == "build-failure":
                    self.assertIn("Error 23", result.stderr)

    def test_coverage_setup_failure_never_starts_cli_tests(self):
        for mode in ("metadata-failure", "show-env-failure"):
            with self.subTest(mode=mode):
                self.env["CLI_ARTIFACT_MODE"] = mode
                result, calls = self.run_make("coverage:lcov")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.cli_tests(calls), [])
                self.assertEqual(list(self.temp.iterdir()), [])

    def test_test_exit_status_and_streams_reach_make(self):
        self.env["CLI_TEST_EXIT"] = "37"
        for target in ("test:unit:cli", "coverage:lcov"):
            with self.subTest(target=target):
                result, calls = self.run_make(target)
                self.assert_cli_path(calls)
                self.assertEqual(result.returncode, 2)
                self.assertIn("Error 37", result.stderr)
                self.assertIn("test stdout", result.stdout)
                self.assertIn("test stderr", result.stderr)
                self.assertEqual(list(self.temp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
