"""Unit tests for e2e image resolution, independent of the VM services."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parent.parent
IMAGES_MODULE = E2E_DIR / "lib/images.py"


class ImageResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        e2e_dir = self.root / "apps/e2e"
        (e2e_dir / "lib").mkdir(parents=True)
        shutil.copy(IMAGES_MODULE, e2e_dir / "lib/images.py")


    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def _write_version(self, version: str) -> None:
        version_file = self.root / "apps/box-images/VERSION"
        version_file.parent.mkdir(parents=True)
        version_file.write_text(f"{version}\n")

    def _run(self, image: str | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        if image is None:
            env.pop("BOXLITE_E2E_IMAGE", None)
        else:
            env["BOXLITE_E2E_IMAGE"] = image
        return subprocess.run(
            [sys.executable, str(self.root / "apps/e2e/lib/images.py")],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_missing_version_fails(self) -> None:
        result = self._run()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot read box image version", result.stderr)

    def test_empty_version_fails(self) -> None:
        self._write_version("")

        result = self._run()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is empty", result.stderr)

    def test_version_file_sets_image(self) -> None:
        self._write_version("9.8.7")

        result = self._run()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ghcr.io/boxlite-ai/boxlite-agent-base:v9.8.7")

    def test_override_bypasses_missing_version(self) -> None:
        result = self._run("custom:override")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "custom:override")

    def test_empty_override_uses_version(self) -> None:
        self._write_version("v9.8.7")

        result = self._run("")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ghcr.io/boxlite-ai/boxlite-agent-base:v9.8.7")


if __name__ == "__main__":
    unittest.main()
