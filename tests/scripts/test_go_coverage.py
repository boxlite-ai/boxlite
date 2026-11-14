"""Exercise the Go coverage recipe without building native SDK dependencies."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class GoCoverageTest(unittest.TestCase):
    def test_image_coverage_uses_c_build_only_with_stubbed_dependencies(self):
        boundary_tool = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

root = Path(os.environ["IMAGE_COVERAGE_ROOT"])
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
library = root / "target/debug/libboxlite.a"
if tool == "cargo":
    library.parent.mkdir(parents=True, exist_ok=True)
    library.write_text("library produced by Cargo")
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps({"tool": tool, "args": args, "library_exists": library.exists()}) + "\\n")
'''
        for stubbed in (False, True):
            with self.subTest(stubbed=stubbed), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch).resolve()
                (root / "sdks/go").mkdir(parents=True)
                tools = root / "bin"
                tools.mkdir()
                for name in ("cargo", "go", "bash"):
                    tool = tools / name
                    tool.write_text(boundary_tool)
                    tool.chmod(0o755)
                (root / "Makefile").write_text(
                    "SHELL := /bin/bash\n"
                    f"PROJECT_ROOT := {root}\n"
                    f"SCRIPT_DIR := {ROOT / 'scripts'}\n"
                    f"include {ROOT / 'make/dev.mk'}\n"
                    f"include {ROOT / 'make/coverage.mk'}\n"
                    + ".DEFAULT:\n" + (ROOT / "Makefile").read_text().split(".DEFAULT:\n", 1)[1]
                )
                env = {**os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
                       "IMAGE_COVERAGE_ROOT": str(root)}
                env.pop("BOXLITE_DEPS_STUB", None)
                if stubbed:
                    env["BOXLITE_DEPS_STUB"] = "1"
                result = subprocess.run(
                    ["make", "coverage:go:images", "SETUP_DONE=1"],
                    cwd=root, env=env, capture_output=True, text=True, timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
                rewrites = [call for call in calls if call["tool"] == "bash"]
                self.assertEqual(len(rewrites), 0 if stubbed else 1, calls)
                tests = [call for call in calls if call["tool"] == "go" and call["args"][0] == "test"]
                self.assertEqual(len(tests), 1, calls)
                self.assertTrue(tests[0]["library_exists"], tests)
                self.assertEqual(tests[0]["args"][-1], "./integration/images")

    def test_secret_server_runs_with_race_and_propagates_failure(self):
        for status in (0, 17):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch).resolve()
                for module in (
                    "sdks/go", "src/deps/libgvproxy-sys/gvproxy-bridge",
                    "apps/runner", "apps/image-service", "apps/secret-server",
                ):
                    (root / module).mkdir(parents=True)
                tools = root / "bin"
                tools.mkdir()
                go = tools / "go"
                go.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json, os, sys\n"
                    "from pathlib import Path\n"
                    "with open(os.environ['GO_COVERAGE_LOG'], 'a') as log:\n"
                    "    log.write(json.dumps([str(Path.cwd()), sys.argv[1:], os.getenv('GOWORK')]) + '\\n')\n"
                    "sys.exit(int(os.environ['SECRET_TEST_STATUS']) if Path.cwd().name == 'secret-server' else 0)\n"
                )
                go.chmod(0o755)
                (root / "Makefile").write_text(
                    f"PROJECT_ROOT := {root}\n"
                    f"include {ROOT / 'make/coverage.mk'}\n"
                    "dev\\:go:\n\t@:\n"
                    + ".DEFAULT:\n" + (ROOT / "Makefile").read_text().split(".DEFAULT:\n", 1)[1]
                )
                log = root / "calls.jsonl"
                result = subprocess.run(
                    ["make", "coverage:go"], cwd=root, text=True,
                    capture_output=True, timeout=20,
                    env={**os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
                         "GO_COVERAGE_LOG": str(log), "SECRET_TEST_STATUS": str(status)},
                )
                self.assertTrue(log.exists(), result.stderr)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                secret_calls = [call for call in calls if call[0] == str(root / "apps/secret-server")]
                self.assertEqual(len(secret_calls), 1, "coverage:go never executed Secret Server tests")
                _, args, gowork = secret_calls[0]
                self.assertEqual(gowork, "off")
                for arg in ("test", "-race", "-covermode=atomic", "-coverpkg=./...", "./..."):
                    self.assertIn(arg, args)
                self.assertIn(f"-coverprofile={root}/target/coverage/secret-server.out", args)
                self.assertEqual(result.returncode == 0, status == 0, result.stderr)
