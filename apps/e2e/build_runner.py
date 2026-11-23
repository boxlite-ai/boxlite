"""Invalidate CGO's cached link when its external native archive changes."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def build(state):
    archive = ROOT / "target/debug/libboxlite.a"
    identity = hashlib.sha256(archive.read_bytes()).hexdigest()
    state = Path(state).absolute()
    stamp = state / "runner-archive.sha256"
    rebuild = not stamp.exists() or stamp.read_text() != identity
    (state / "bin").mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["go", "build", *(["-a"] if rebuild else []), "-tags", "boxlite_dev",
         "-o", str(state / "bin/runner"), "./cmd/runner"],
        cwd=ROOT / "apps/runner", env=dict(os.environ, CGO_ENABLED="1"), check=True)
    # Failed builds must never certify a new archive.
    stamp.write_text(identity)


if __name__ == "__main__":
    build(sys.argv[1])
