"""Exercise infrastructure dependency setup through the real Make recipe."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

MAKEFILE = Path(__file__).resolve().parents[2] / "make/test.mk"


class InfraDependenciesTest(unittest.TestCase):
    def test_collector_readiness_controls_installation(self):
        cases = [("missing", 0), ("stale", 0), ("nonexecutable", 0), ("ready", 0), ("stale", 17)]
        for state, install_exit in cases:
            with (
                self.subTest(state=state, install_exit=install_exit),
                tempfile.TemporaryDirectory() as scratch,
            ):
                root = Path(scratch) / "repository with spaces"
                infra = root / "apps/infra"
                infra.mkdir(parents=True)
                collector = infra / "node_modules/.bin/c8"
                if state != "missing":
                    collector.parent.mkdir(parents=True)
                if state in ("ready", "nonexecutable"):
                    collector.write_text("#!/bin/sh\nexit 0\n")
                    collector.chmod(0o755 if state == "ready" else 0o644)
                tools = root / "bin"
                tools.mkdir()
                npm = tools / "npm"
                npm.write_text(
                    '#!/bin/sh\nprintf "%s\\n" "$*" > "$INFRA_INSTALL_LOG"\n'
                    'exit "$INFRA_INSTALL_EXIT"\n'
                )
                npm.chmod(0o755)
                log = root / "install.log"
                env = {
                    **os.environ,
                    "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                    "INFRA_INSTALL_LOG": str(log),
                    "INFRA_INSTALL_EXIT": str(install_exit),
                }
                result = subprocess.run(
                    ["make", "-f", str(MAKEFILE), "_ensure-infra-deps"],
                    cwd=root, env=env, capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(log.exists(), state != "ready", result.stdout + result.stderr)
                if log.exists():
                    self.assertEqual(log.read_text().strip(), "ci --no-audit --no-fund")
                self.assertEqual(result.returncode, 2 if install_exit else 0, result.stderr)
