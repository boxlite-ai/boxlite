"""Resolve the TypeScript driver runner without breaking unmanaged runs."""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def driver_argv(repo: Path, driver: Path) -> list[str] | None:
    """Return the argv that runs `driver`, or None when no runner is installed.

    The managed environment sets BOXLITE_E2E_TSX; a missing target there is a
    setup defect, not a reason to skip. Unmanaged runs (cloud CI) keep the
    workspace tsx when present and the historical npx fallback otherwise, so a
    case never depends on packages this repository did not install.
    """
    override = os.environ.get("BOXLITE_E2E_TSX")
    if override:
        path = Path(override)
        if not path.is_file():
            raise RuntimeError(
                f"BOXLITE_E2E_TSX points at missing {path}; run make test:e2e:setup"
            )
        return [str(path), str(driver)]
    for path, prefix in (
        (repo / "apps/node_modules/.bin/tsx", []),
        (repo / "apps/node_modules/tsx/dist/cli.mjs", ["node"]),
    ):
        if path.is_file():
            return [*prefix, str(path), str(driver)]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", "tsx", str(driver)]
    return None
