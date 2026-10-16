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
    for target in args:
        if target in ("dev:python", "dev:node", "test:unit:c"):
            sdk = target.split(":")[-1]
            os.chdir(root if sdk == "c" else root / "sdks" / sdk)
            destination = target_dir()
            destination.mkdir(parents=True, exist_ok=True)
            (destination / (sdk + ".o")).touch()
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
    def run_collector(self, override):
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
            for sdk in ("python", "node", "c"):
                self.assertIn("SF:" + str(expected / (sdk + ".o")), report)

    def test_relative_target_keeps_sdk_objects_in_the_report(self):
        self.run_collector("relative target")

    def test_absolute_target_is_preserved(self):
        self.run_collector("absolute")

    def test_default_target_keeps_sdk_objects_in_the_report(self):
        self.run_collector(None)


if __name__ == "__main__":
    unittest.main()
