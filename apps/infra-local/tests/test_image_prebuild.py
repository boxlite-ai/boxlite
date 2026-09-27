"""Validate disk paths returned by the internal image tool."""

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from compose import image_prebuild


class ImagePrebuildTests(unittest.TestCase):
    def test_internal_tool_rejects_incomplete_result(self):
        response = SimpleNamespace(returncode=0, stdout='BOXLITE_IMAGE_DISKS={"other":"/tmp/x"}\n', stderr="")
        cfg = SimpleNamespace(repo_root=Path("/repo"))
        with patch.object(image_prebuild.InfraConfig, "load", return_value=cfg), \
             patch.object(image_prebuild.subprocess, "run", return_value=response), \
             self.assertRaisesRegex(RuntimeError, "invalid disk paths"):
            image_prebuild._run_image_tool(Path("/home"), "path", ["example:1"])


if __name__ == "__main__":
    unittest.main()
