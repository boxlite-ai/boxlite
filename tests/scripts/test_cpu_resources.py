"""Exercise the production generator against isolated copies of its contracts."""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts/generate_cpu_resources.py"


class CpuResourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in (
            "openapi/cpu-resources.json",
            "openapi/box.openapi.yaml",
            "apps/runner/pkg/api/dto/box.go",
            "docs/guides/resource-limits.md",
            "apps/runner/pkg/api/docs/swagger.json",
            "apps/runner/pkg/api/docs/swagger.yaml",
            "apps/runner/pkg/api/docs/docs.go",
        ):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)

    def run_generator(self, *args):
        return subprocess.run(
            [sys.executable, str(GENERATOR), "--root", str(self.root), *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def snapshot(self):
        return {
            str(p.relative_to(self.root)): p.read_bytes()
            for p in self.root.rglob("*")
            if p.is_file()
        }

    def test_generate_is_idempotent_and_check_is_read_only(self):
        result = self.run_generator()
        self.assertEqual(result.returncode, 0, result.stderr)
        before = self.snapshot()
        self.assertEqual(self.run_generator().returncode, 0)
        self.assertEqual(self.run_generator("--check").returncode, 0)
        self.assertEqual(before, self.snapshot())
        (self.root / "apps/libs/resource-limits/src/cpu.ts").unlink()
        before = self.snapshot()
        self.assertNotEqual(self.run_generator("--check").returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_changed_policy_updates_consumers_and_requires_new_swagger(self):
        policy = self.root / "openapi/cpu-resources.json"
        original = json.loads(policy.read_text())["minimum_millicpus"]
        changed = original + 1 if original < 1000 else original - 1
        cores = f"{changed / 1000:g}"
        policy.write_text(json.dumps({"minimum_millicpus": changed}))
        result = self.run_generator()
        self.assertEqual(result.returncode, 0, result.stderr)
        for path, expected in (
            (
                "src/boxlite/src/runtime/cpu_limits.rs",
                f"MIN_CPU_MILLICPU: u32 = {changed}",
            ),
            ("apps/runner/pkg/api/dto/cpu_limits.go", f"MinCPUMillicpu = {changed}"),
            ("apps/libs/resource-limits/src/cpu.ts", f"MIN_CPU_MILLICPU = {changed}"),
            ("apps/runner/pkg/api/dto/box.go", f"min={cores},max=16"),
            ("openapi/box.openapi.yaml", f"minimum: {cores}"),
            ("docs/guides/resource-limits.md", f"**Range:** `{cores}` to `16`"),
        ):
            self.assertIn(expected, (self.root / path).read_text())
        result = self.run_generator("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Runner", result.stderr)

    def test_invalid_policy_and_missing_anchor_never_partially_write(self):
        policy = self.root / "openapi/cpu-resources.json"
        for value in (True, 0, -1, 1.5, "125", 1001):
            with self.subTest(value=value):
                policy.write_text(json.dumps({"minimum_millicpus": value}))
                before = self.snapshot()
                self.assertNotEqual(self.run_generator().returncode, 0)
                self.assertEqual(before, self.snapshot())
        shutil.copyfile(ROOT / "openapi/cpu-resources.json", policy)
        path = self.root / "apps/runner/pkg/api/dto/box.go"
        original = path.read_text()
        for invalid in (
            original.replace("CpuQuota", "MissingQuota"),
            original + original,
        ):
            path.write_text(invalid)
            before = self.snapshot()
            self.assertNotEqual(self.run_generator().returncode, 0)
            self.assertEqual(before, self.snapshot())
