"""REST E2E coverage for the Node SDK's SimpleBox exit-time cleanup contract.

Mirrors test_simplebox_lifecycle.py: SimpleBox.stop() (sdks/node/lib/simplebox.ts)
must delete the box when autoRemove is true, not just stop it - the same
gap fixed on the Python side in #1186.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context
from images import default_image


REPO = Path(__file__).resolve().parents[3]
NODE_SDK = REPO / "sdks/node"
DRIVER = REPO / "apps/e2e/sdks/node/e2e_simplebox_lifecycle.ts"


def _has_node_napi_build() -> bool:
    return any(
        directory.exists() and any(directory.rglob("*.node"))
        for directory in (NODE_SDK / "native", NODE_SDK / "dist", NODE_SDK / "npm")
    )


@pytest.fixture(scope="module")
def node_env():
    if auth_context().auth != "api-key":
        pytest.skip("Node SDK E2E only supports API-key credentials today")
    if not shutil.which("npx"):
        pytest.skip("npx not installed")
    if not _has_node_napi_build():
        pytest.skip("Node SDK napi binding not built")
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": default_image(),
    }


def test_node_sdk_simplebox_lifecycle(node_env):
    result = subprocess.run(
        ["npx", "--yes", "tsx", str(DRIVER)],
        env=node_env,
        timeout=60,
        capture_output=True,
        text=True,
        cwd=str(NODE_SDK),
    )
    assert result.returncode == 0, (
        f"exit={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "AUTOREMOVE_TRUE_DELETES=ok" in result.stdout
    assert "AUTOREMOVE_FALSE_KEEPS=ok" in result.stdout
