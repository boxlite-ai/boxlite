"""Keep DinD firmware selected throughout the development artifact build."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class RunnerArtifactFirmwareTest(unittest.TestCase):
    def test_prepares_and_keeps_dind_source_for_both_native_builds(self):
        dockerfile = ROOT / "apps/runner/packaging/dev-artifact.Dockerfile"
        instructions = "\n".join(
            line.strip()
            for line in dockerfile.read_text().splitlines()
            if not line.lstrip().startswith("#")
        )
        steps = [
            "RUN make setup:build guest",
            "RUN python3 scripts/build/prepare_dind_firmware.py /work/.firmware/dind",
            "ENV BOXLITE_LIBKRUNFW_SOURCE=/work/.firmware/dind",
            "RUN SKIP_GUEST_BUILD=1 make runtime",
            "cargo build --release -p boxlite-c",
        ]
        for step in steps:
            self.assertIn(step, instructions, f"Missing firmware build step: {step}")
        positions = [instructions.index(step) for step in steps]
        self.assertEqual(
            positions,
            sorted(positions),
            "Prepare firmware after setup and keep ENV set before both native builds",
        )


if __name__ == "__main__":
    unittest.main()
