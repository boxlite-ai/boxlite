"""Exercise the Go coverage recipe without building native SDK dependencies."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class GoCoverageTest(unittest.TestCase):
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
