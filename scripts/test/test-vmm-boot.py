#!/usr/bin/env python3
"""Exercise the boot-artifact build entry point without starting Docker."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "scripts/build/build-vmm-boot.sh"


class BuildEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="boxlite boot contracts ")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.arguments = self.path / "arguments"
        docker = self.path / "docker"
        docker.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGUMENTS"\n'
            'exit "${DOCKER_STATUS:-0}"\n'
        )
        docker.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": f"{self.path}{os.pathsep}{os.environ['PATH']}",
            "DOCKER_ARGUMENTS": str(self.arguments),
        }

    def invoke(self, *arguments):
        return subprocess.run(
            ["bash", str(BUILD), *arguments],
            cwd=self.path,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_default_build_uses_repository_paths_from_another_directory(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.arguments.read_text().splitlines(),
            [
                "buildx", "build", "--target", "artifacts", "--output",
                f"type=local,dest={ROOT}/target/vmm/boot/x86_64",
                str(ROOT / "src/vmm/boot"),
            ],
        )

    def test_rebuild_preserves_literal_output_path(self):
        output = self.path / "artifacts $(touch unexpected)"
        result = self.invoke("--output", str(output), "--rebuild")
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.arguments.read_text().splitlines()
        self.assertIn(f"type=local,dest={output}", arguments)
        self.assertEqual(arguments[4:6], ["--no-cache-filter", "build"])
        self.assertFalse((self.path / "unexpected").exists())

    def test_invalid_arguments_never_start_docker(self):
        for arguments in [
            ("--output",), ("--output", ""), ("--unknown",),
            ("--output", "a,b"), ("--output", 'a"b'), ("--output", "a\nb"),
            ("--output", "a\rb"),
        ]:
            with self.subTest(arguments=arguments):
                result = self.invoke(*arguments)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.arguments.exists())

    def test_docker_failure_does_not_report_success(self):
        self.environment["DOCKER_STATUS"] = "42"
        result = self.invoke()
        self.assertEqual(result.returncode, 42)
        self.assertNotIn("Boot artifacts:", result.stdout)


if __name__ == "__main__":
    unittest.main()
