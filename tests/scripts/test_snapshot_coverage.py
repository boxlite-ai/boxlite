"""Exercise the coverage recipe's CLI selection without running native builds."""

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


RECIPE = Path(__file__).resolve().parents[2] / "make/coverage.mk"


class SnapshotCoverageSelectionTest(unittest.TestCase):
    def test_cli_snapshot_boundary_runs_alongside_auth_without_vm_suites(self):
        make = shutil.which("make")
        self.assertIsNotNone(make)
        with tempfile.TemporaryDirectory(prefix="snapshot coverage ") as scratch:
            root = Path(scratch)
            recipe = root / "coverage.mk"
            shutil.copy2(RECIPE, recipe)
            tools = root / "tools"
            tools.mkdir()
            cargo = tools / "cargo"
            cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "with open(os.environ['SNAPSHOT_COVERAGE_LOG'], 'a') as log:\n"
                "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            )
            cargo.chmod(0o755)
            log = root / "commands.jsonl"
            env = os.environ.copy()
            env["PATH"] = str(tools) + os.pathsep + env["PATH"]
            env["SNAPSHOT_COVERAGE_LOG"] = str(log)
            result = subprocess.run(
                [
                    make,
                    "-f",
                    str(recipe),
                    "coverage:lcov",
                    f"MAKE={shlex.quote(make)} -f {shlex.quote(str(recipe))}",
                ],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            cli = [args for args in calls if "boxlite-cli" in args]
            self.assertEqual(len(cli), 1, calls)
            selected = [
                cli[0][index + 1]
                for index, arg in enumerate(cli[0][:-1])
                if arg == "--test"
            ]
            self.assertIn("snapshots_rest", selected)
            self.assertIn("auth", selected)
            self.assertIn("--bins", cli[0])
            self.assertNotIn("--tests", cli[0])
            self.assertNotIn("*", selected)


if __name__ == "__main__":
    unittest.main()
