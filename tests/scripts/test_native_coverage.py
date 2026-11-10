"""Exercise the native coverage collector across SDK working directories."""

import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

COLLECTOR = Path(__file__).resolve().parents[2] / "scripts/test/coverage-bindings.sh"

# Model Cargo's path resolution at the external-tool boundary. The production
# collector must make the SDK builds and final report agree on the directory.
BUILD_TOOL = """#!/usr/bin/env python3
import os
from pathlib import Path
import shlex
import sys

root = Path(os.environ["COVERAGE_TEST_ROOT"])
tool = Path(sys.argv[0]).name
args = sys.argv[1:]

def target_dir():
    return Path(os.environ["CARGO_TARGET_DIR"]).resolve()

if tool == "make":
    import json

    target_dir().mkdir(parents=True, exist_ok=True)
    with (target_dir() / "make-invocations.jsonl").open("a") as log:
        log.write(json.dumps(args) + "\\n")
    for target in args:
        if target in ("dev:python", "dev:node", "test:unit:c"):
            sdk = target.split(":")[-1]
            os.chdir(root if sdk == "c" else root / "sdks" / sdk)
            destination = target_dir()
            destination.mkdir(parents=True, exist_ok=True)
            (destination / (sdk + ".o")).touch()
        elif target == "coverage:python":
            # The Python suite must run under the native gate: with the
            # extension built first, absence or breakage then fails the
            # collection instead of silently skipping the native tests.
            target_dir().mkdir(parents=True, exist_ok=True)
            (target_dir() / "python-gate").write_text(
                os.environ.get("BOXLITE_REQUIRE_NATIVE", "")
            )
        elif target == "coverage:go:checkpoint":
            (target_dir() / "go-link-flags").write_text(
                os.environ.get("CGO_LDFLAGS", "")
            )
            (root / "target/coverage").mkdir(parents=True, exist_ok=True)
            (root / "target/coverage/checkpoint-native.test").touch()
elif tool == "rustc":
    if args == ["--print", "target-libdir"]:
        library_dir = root / "rustlib"
        library_dir.mkdir(exist_ok=True)
        (library_dir / "libprofiler_builtins-fixture.rlib").touch()
        print(library_dir)
    else:
        print("host: aarch64-apple-darwin")
elif tool == "llvm-cov":
    assert args[:2] == ["export", "-format=lcov"]
    profile = Path(args[2].removeprefix("-instr-profile="))
    assert profile == target_dir() / "native.profdata" and profile.is_file()
    binary = root / "target/coverage/checkpoint-native.test"
    assert Path(args[3]) == binary and binary.is_file()
    print("SF:" + str(binary))
elif args[:2] == ["llvm-cov", "show-env"]:
    print("export CARGO_LLVM_COV_TARGET_DIR=" + shlex.quote(str(target_dir())))
elif args[:2] == ["llvm-cov", "report"]:
    destination = target_dir()
    (destination / "report-flags").write_text(os.environ.get("LLVM_COV_FLAGS", ""))
    objects = [destination / (sdk + ".o") for sdk in ("python", "node", "c")]
    missing = [obj.name for obj in objects if not obj.is_file()]
    if missing:
        print("missing SDK objects: " + ", ".join(missing), file=sys.stderr)
        sys.exit(1)
    report = Path(args[args.index("--output-path") + 1])
    report.write_text("\\n".join("SF:" + str(obj) for obj in objects))
    (destination / "native.profdata").touch()
"""


class NativeCoveragePathsTest(unittest.TestCase):
    def test_sdk_integration_keeps_native_go_archives_in_the_vm_workflow(self):
        import json

        suites = COLLECTOR.parents[2] / "make/test.mk"
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            recorder = root / "record-make"
            recorder.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                'with open(os.environ["SDK_SUITE_LOG"], "a") as log:\n'
                '    log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
            )
            recorder.chmod(0o755)
            (root / "Makefile").write_text(f"include {suites}\n")
            log = root / "sdk-suites.jsonl"
            result = subprocess.run(
                ["make", "test:integration:sdk", "SETUP_DONE=1", f"MAKE={recorder}"],
                cwd=root,
                env={**os.environ, "SDK_SUITE_LOG": str(log)},
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertIn(
                ["test:integration:go", "SETUP_DONE=1"],
                calls,
                "native Go archive tests must run through the VM integration entry point",
            )

    def test_core_coverage_runs_the_no_vm_checkpoint_cli_binary(self):
        import json

        coverage = COLLECTOR.parents[2] / "make/coverage.mk"
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            tools = root / "bin"
            tools.mkdir()
            cargo = tools / "cargo"
            cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                'with open(os.environ["CARGO_ARGV_LOG"], "a") as log:\n'
                '    log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
            )
            cargo.chmod(0o755)
            (root / "Makefile").write_text(f"include {coverage}\n")
            log = root / "cargo.jsonl"
            env = {
                **os.environ,
                "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                "CARGO_ARGV_LOG": str(log),
            }
            result = subprocess.run(
                ["make", "coverage:lcov"],
                check=False,
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            cli_calls = [args for args in calls if "boxlite-cli" in args]
            self.assertTrue(cli_calls, "no CLI coverage invocation")
            self.assertTrue(
                any(
                    args[index : index + 2] == ["--test", "checkpoint"]
                    for args in cli_calls
                    for index in range(len(args) - 1)
                ),
                "the existing checkpoint CLI HTTP tests must contribute coverage",
            )
            self.assertTrue(all("--tests" not in args for args in cli_calls))

    def run_collector(self, override, gate_required=False):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve() / "repository with spaces"
            collector = root / "scripts/test/coverage-bindings.sh"
            collector.parent.mkdir(parents=True)
            shutil.copy2(COLLECTOR, collector)
            tools = root / "bin"
            tools.mkdir()
            for name in ("cargo", "make", "rustc", "llvm-cov"):
                executable = tools / name
                executable.write_text(BUILD_TOOL)
                executable.chmod(0o755)
            for sdk in ("python", "node", "c"):
                (root / "sdks" / sdk).mkdir(parents=True)

            env = os.environ.copy()
            env["PATH"] = str(tools) + os.pathsep + env["PATH"]
            env["COVERAGE_TEST_ROOT"] = str(root)
            env.pop("CARGO_TARGET_DIR", None)
            # The gate assertion must observe only what the collector sets;
            # an inherited variable would mask a reverted script.
            env.pop("BOXLITE_REQUIRE_NATIVE", None)
            if override == "absolute":
                expected = Path(scratch).resolve() / "external target"
                env["CARGO_TARGET_DIR"] = str(expected)
            elif override is not None:
                expected = root / override
                env["CARGO_TARGET_DIR"] = override
            else:
                expected = root / "target/native-sdk-coverage"

            result = subprocess.run(
                ["bash", str(collector)],
                check=False,
                cwd=scratch,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = (root / "target/coverage/native-sdk/lcov.info").read_text()
            # The Node integration step must stay scoped to the no-VM
            # loopback suites. Read the make argv the collector actually
            # passed and apply its FILTER the way vitest applies a
            # testNamePattern: the loopback suites are selected and the
            # VM-booting SSH suites are not.
            import json

            invocations_path = (
                root / "target/native-sdk-coverage/make-invocations.jsonl"
                if override is None
                else expected / "make-invocations.jsonl"
            )
            node_runs = []
            ffi_runs = []
            go_archive_runs = []
            for line in invocations_path.read_text().splitlines():
                argv = json.loads(line)
                if "test:integration:node" in argv:
                    node_runs.append(argv)
                if "test:unit:ffi" in argv:
                    ffi_runs.append(argv)
                if "coverage:go:checkpoint" in argv:
                    go_archive_runs.append(argv)
            self.assertTrue(
                ffi_runs, "Rust C ABI tests must contribute native coverage"
            )
            self.assertEqual(
                len(go_archive_runs),
                1,
                "native Go archive ownership must contribute coverage",
            )
            go_link_flags = shlex.split((expected / "go-link-flags").read_text())
            self.assertEqual(
                go_link_flags[0],
                str(expected / "debug/libboxlite.a"),
                "Go callers must link the instrumented native archive first",
            )
            self.assertEqual(
                go_link_flags[1],
                str(root / "rustlib/libprofiler_builtins-fixture.rlib"),
                "CGO must link Rust's matching coverage profile runtime",
            )
            self.assertIn(
                "SF:" + str(root / "target/coverage/checkpoint-native.test"),
                (root / "target/coverage/native-sdk/go-lcov.info").read_text(),
                "Go native coverage must use the retained test executable",
            )
            self.assertTrue(node_runs, str(invocations_path))
            for argv in node_runs:
                filters = [a for a in argv if a.startswith("FILTER=")]
                self.assertEqual(
                    len(filters), 1, f"test:integration:node ran unfiltered: {argv!r}"
                )
                pattern = filters[0][len("FILTER=") :]
                for suite in (
                    "image catalog",
                    "registry logins",
                    "native box privilege metadata",
                    "box.ssh over a REST transport",
                    "SimpleBox.ssh over a REST transport",
                    "checkpoint native methods reject an unwrapped receiver",
                    "checkpoint native REST calls preserve configuration inheritance and result identity",
                ):
                    self.assertRegex(suite, pattern)
                for vm_suite in (
                    "SimpleBox.ssh",
                    "SimpleBox.ssh with an explicit main command",
                ):
                    self.assertNotRegex(vm_suite, pattern)
            for sdk in ("python", "node", "c"):
                self.assertIn("SF:" + str(expected / (sdk + ".o")), report)
            if gate_required:
                marker = expected / "python-gate"
                self.assertTrue(marker.is_file(), "make coverage:python never ran")
                self.assertEqual(
                    marker.read_text(),
                    "1",
                    "the Python suite must run with BOXLITE_REQUIRE_NATIVE=1",
                )

    def test_relative_target_keeps_sdk_objects_in_the_report(self):
        self.run_collector("relative target")

    def test_absolute_target_is_preserved(self):
        self.run_collector("absolute")

    def test_default_target_keeps_sdk_objects_in_the_report(self):
        self.run_collector(None)

    def test_the_python_suite_runs_under_the_native_gate(self):
        self.run_collector(None, gate_required=True)


if __name__ == "__main__":
    unittest.main()
