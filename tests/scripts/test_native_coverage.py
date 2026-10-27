"""Exercise the native coverage collector across SDK working directories."""

import os
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
elif tool == "rustc":
    print("host: aarch64-apple-darwin")
elif args[:2] == ["llvm-cov", "report"]:
    destination = target_dir()
    objects = [destination / (sdk + ".o") for sdk in ("python", "node", "c")]
    missing = [obj.name for obj in objects if not obj.is_file()]
    if missing:
        print("missing SDK objects: " + ", ".join(missing), file=sys.stderr)
        sys.exit(1)
    report = Path(args[args.index("--output-path") + 1])
    report.write_text("\\n".join("SF:" + str(obj) for obj in objects))
"""


class NativeCoveragePathsTest(unittest.TestCase):
    def run_collector(self, override, gate_required=False):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve() / "repository with spaces"
            collector = root / "scripts/test/coverage-bindings.sh"
            collector.parent.mkdir(parents=True)
            shutil.copy2(COLLECTOR, collector)
            tools = root / "bin"
            tools.mkdir()
            for name in ("cargo", "make", "rustc"):
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
            for line in invocations_path.read_text().splitlines():
                argv = json.loads(line)
                if "test:integration:node" in argv:
                    node_runs.append(argv)
            self.assertTrue(node_runs, str(invocations_path))
            for argv in node_runs:
                filters = [a for a in argv if a.startswith("FILTER=")]
                self.assertEqual(
                    len(filters), 1, "test:integration:node ran unfiltered: %r" % argv
                )
                pattern = filters[0][len("FILTER="):]
                for suite in (
                    "image catalog",
                    "registry logins",
                    "box.ssh over a REST transport",
                    "SimpleBox.ssh over a REST transport",
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
