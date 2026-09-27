"""Call the project-internal OCI image disk tool."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .config import InfraConfig

_RESULT_PREFIX = "BOXLITE_IMAGE_DISKS="


def _run_image_tool(home: Path, mode: str, references: list[str]) -> dict[str, str]:
    tool = InfraConfig.load().repo_root / ".apps-local" / "bin" / "boxlite-infra-image"
    result = subprocess.run(
        [str(tool), "--home", str(home), "--mode", mode, *references],
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        text=True,
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"internal image tool failed (exit {result.returncode}); see stderr above")
    line = next((line for line in result.stdout.splitlines() if line.startswith(_RESULT_PREFIX)), None)
    if line is None:
        raise RuntimeError("internal image tool returned no disk paths")
    paths = json.loads(line[len(_RESULT_PREFIX):])
    if not isinstance(paths, dict) or set(paths) != set(references) or not all(
        isinstance(path, str) for path in paths.values()
    ):
        raise RuntimeError("internal image tool returned invalid disk paths")
    return paths
