"""Cloud kernel selection must not change development package builds."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class RunnerArtifactFirmwareTest(unittest.TestCase):
    def test_build_uses_the_default_firmware_dependency(self):
        dockerfile = ROOT / "apps/runner/packaging/dev-artifact.Dockerfile"
        instructions = "\n".join(
            line.strip()
            for line in dockerfile.read_text().splitlines()
            if not line.lstrip().startswith("#")
        )
        steps = [
            "RUN make setup:build guest",
            "RUN SKIP_GUEST_BUILD=1 make runtime",
            "cargo build --release -p boxlite-c",
        ]
        for step in steps:
            self.assertIn(step, instructions, f"Missing firmware build step: {step}")
        positions = [instructions.index(step) for step in steps]
        self.assertEqual(
            positions,
            sorted(positions),
            "Build the runtime before the C SDK",
        )
        self.assertNotIn("prepare_dind_firmware", instructions)
        self.assertNotIn("BOXLITE_LIBKRUNFW_SOURCE", instructions)


if __name__ == "__main__":
    unittest.main()
