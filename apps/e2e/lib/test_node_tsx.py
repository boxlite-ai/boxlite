"""Resolve TypeScript drivers through the managed tsx or the npx fallback."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import node_tsx


class DriverArgvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.driver = self.repo / "driver.ts"
        self.driver.write_text("")

    def test_managed_missing_override_is_a_setup_error(self):
        missing = self.repo / "missing-tsx"
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": str(missing)}):
            with self.assertRaisesRegex(RuntimeError, "run make test:e2e:setup"):
                node_tsx.driver_argv(self.repo, self.driver)

    def test_managed_override_wins(self):
        tsx = self.repo / "tsx"
        tsx.write_text("")
        tsx.chmod(0o755)
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": str(tsx)}):
            self.assertEqual(
                node_tsx.driver_argv(self.repo, self.driver),
                [str(tsx), str(self.driver)],
            )

    def test_workspace_bin_is_preferred(self):
        bin_tsx = self.repo / "apps/node_modules/.bin/tsx"
        bin_tsx.parent.mkdir(parents=True)
        bin_tsx.write_text("")
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": ""}), \
                patch.object(node_tsx.shutil, "which", return_value="/usr/bin/npx"):
            self.assertEqual(
                node_tsx.driver_argv(self.repo, self.driver),
                [str(bin_tsx), str(self.driver)],
            )

    def test_workspace_cli_uses_node(self):
        cli = self.repo / "apps/node_modules/tsx/dist/cli.mjs"
        cli.parent.mkdir(parents=True)
        cli.write_text("")
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": ""}), \
                patch.object(node_tsx.shutil, "which", return_value="/usr/bin/npx"):
            self.assertEqual(
                node_tsx.driver_argv(self.repo, self.driver),
                ["node", str(cli), str(self.driver)],
            )

    def test_npx_is_the_unmanaged_fallback(self):
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": ""}), \
                patch.object(node_tsx.shutil, "which", return_value="/usr/bin/npx"):
            self.assertEqual(
                node_tsx.driver_argv(self.repo, self.driver),
                ["/usr/bin/npx", "--yes", "tsx", str(self.driver)],
            )

    def test_missing_runner_reports_none(self):
        with patch.dict(os.environ, {"BOXLITE_E2E_TSX": ""}), \
                patch.object(node_tsx.shutil, "which", return_value=None):
            self.assertIsNone(node_tsx.driver_argv(self.repo, self.driver))


if __name__ == "__main__":
    unittest.main()
