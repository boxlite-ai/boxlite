"""Exercise the native commands shipped in the runner artifact Dockerfile."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = "BOXLITE_LIBKRUNFW_VARIANT"


class RunnerArtifactFirmwareTest(unittest.TestCase):
    def test_variant_reaches_both_native_builds(self):
        instructions = (
            (ROOT / "apps/runner/packaging/dev-artifact.Dockerfile")
            .read_text()
            .replace("\\\n", "")
        )
        native = next(
            line[4:]
            for line in instructions.splitlines()
            if line.startswith("RUN SKIP_GUEST_BUILD=1 make runtime")
        )
        default = re.search(rf"^ARG {SELECTOR}=(\S+)$", instructions, re.MULTILINE)
        setting = re.search(rf"^ENV {SELECTOR}=(\S+)$", instructions, re.MULTILINE)
        for requested, expected in [
            (None, "dind"),
            ("generic", "generic"),
            ("dind", "dind"),
        ]:
            with (
                self.subTest(requested=requested),
                tempfile.TemporaryDirectory() as scratch,
            ):
                root = Path(scratch)
                env = dict(
                    os.environ, PATH=f"{root}:/usr/bin:/bin", TRACE=str(root / "trace")
                )
                env.pop(SELECTOR, None)
                # Resolve only the Dockerfile's actual ARG/ENV instruction for this input.
                if setting:
                    value = requested if requested is not None else default.group(1)
                    env[SELECTOR] = (
                        setting.group(1)
                        .replace(f"${{{SELECTOR}}}", value)
                        .replace(f"${SELECTOR}", value)
                    )
                for name in ["make", "cargo", "bash", "cp"]:
                    body = (
                        f'printf "{name} %s\\n" "${{{SELECTOR}:-unset}}" >> "$TRACE"'
                        if name in ["make", "cargo"]
                        else ":"
                    )
                    tool = root / name
                    tool.write_text(f"#!/bin/sh\n{body}\n")
                    tool.chmod(0o755)
                result = subprocess.run(
                    ["/bin/bash", "-ec", native],
                    check=False,
                    env=env,
                    cwd=root,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    (root / "trace").read_text().splitlines(),
                    [f"make {expected}", f"cargo {expected}"],
                )


if __name__ == "__main__":
    unittest.main()
