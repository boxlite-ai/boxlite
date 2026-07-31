"""Unit tests for e2e image resolution, independent of the VM services."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parent.parent
RUN_SCRIPT = E2E_DIR / "run.sh"
IMAGES_MODULE = E2E_DIR / "lib/images.py"


class ImageResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        e2e_dir = self.root / "scripts/test/e2e"
        (e2e_dir / "lib").mkdir(parents=True)
        shutil.copy(RUN_SCRIPT, e2e_dir / "run.sh")
        shutil.copy(IMAGES_MODULE, e2e_dir / "lib/images.py")

        self.systemctl_marker = self.root / "systemctl-called"
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        self._write_executable(
            fake_bin / "systemctl",
            "#!/bin/sh\n"
            ': > "$BOXLITE_E2E_TEST_SYSTEMCTL_MARKER"\n'
            "exit 0\n",
        )
        self._write_executable(
            fake_bin / "python3",
            "#!/bin/sh\n"
            'case "$1" in\n'
            f'  */lib/images.py) exec "{sys.executable}" "$@" ;;\n'
            "  *) exit 0 ;;\n"
            "esac\n",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    @staticmethod
    def _write_executable(path: Path, content: str) -> None:
        path.write_text(content)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _write_version(self, version: str) -> None:
        version_file = self.root / "apps/box-images/VERSION"
        version_file.parent.mkdir(parents=True)
        version_file.write_text(f"{version}\n")

    def _run(self, image: str | None = None) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
            "BOXLITE_E2E_TEST_SYSTEMCTL_MARKER": str(self.systemctl_marker),
        }
        if image is None:
            env.pop("BOXLITE_E2E_IMAGE", None)
        else:
            env["BOXLITE_E2E_IMAGE"] = image
        return subprocess.run(
            ["bash", str(self.root / "scripts/test/e2e/run.sh")],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_missing_version_stops_before_bootstrap(self) -> None:
        result = self._run()

        self.assertFalse(self.systemctl_marker.exists(), "bootstrap check ran after resolver failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot read box image version", result.stderr)

    def test_empty_resolver_output_stops(self) -> None:
        (self.root / "scripts/test/e2e/lib/images.py").write_text("")

        result = self._run()

        self.assertFalse(self.systemctl_marker.exists(), "bootstrap check ran after empty resolver")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unable to resolve BOXLITE_E2E_IMAGE", result.stderr)

    def test_version_file_sets_image(self) -> None:
        self._write_version("9.8.7")

        result = self._run()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.systemctl_marker.exists(), "bootstrap check did not run")
        self.assertIn(
            "── image: ghcr.io/boxlite-ai/boxlite-agent-base:v9.8.7 ──",
            result.stdout,
        )

    def test_override_bypasses_missing_version(self) -> None:
        result = self._run("custom:override")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.systemctl_marker.exists(), "bootstrap check did not run")
        self.assertIn("── image: custom:override ──", result.stdout)


if __name__ == "__main__":
    unittest.main()
