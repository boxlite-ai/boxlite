"""The shell entry forwards pytest arguments to the manager."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

RUN = Path(__file__).resolve().parent.parent / "run.sh"


class RunScriptTest(unittest.TestCase):
    def test_forwards_run_and_arguments(self):
        with tempfile.TemporaryDirectory() as temporary:
            scripts = Path(temporary) / "apps/e2e"
            scripts.mkdir(parents=True)
            (scripts / "run.sh").write_text(RUN.read_text())
            record = Path(temporary) / "argv.json"
            (scripts / "manage.py").write_text(
                "import json, pathlib, sys\n"
                f"pathlib.Path({str(record)!r}).write_text(json.dumps(sys.argv[1:]))\n"
            )
            result = subprocess.run(
                ["bash", str(scripts / "run.sh"), "-k", "exec user"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(record.read_text()),
                ["run", "--", "-k", "exec user"],
            )


if __name__ == "__main__":
    unittest.main()
