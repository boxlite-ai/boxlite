"""Node SDK REST E2E: exec, copy, error typing.

Extends test_node_entry.py's smoke (create+remove) with deeper
coverage. Each test spawns a TypeScript driver via npx tsx.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context

REPO = Path(__file__).resolve().parents[4]
NODE_SDK = REPO / "sdks/node"
DRIVERS = REPO / "scripts/test/e2e/sdks/node"
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")


def _has_node_napi_build() -> bool:
    for p in [NODE_SDK / "native", NODE_SDK / "dist", NODE_SDK / "npm"]:
        if p.exists() and any(p.rglob("*.node")):
            return True
    return False


@pytest.fixture(scope="module")
def node_env():
    if auth_context().auth != "api-key":
        pytest.skip("Node SDK E2E only supports API-key today")
    if not shutil.which("npx"):
        pytest.skip("npx not installed")
    if not _has_node_napi_build():
        pytest.skip("Node SDK napi binding not built")
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": IMAGE,
    }


def _run_driver(node_env, name: str) -> subprocess.CompletedProcess:
    src = DRIVERS / name
    assert src.exists(), f"{src} missing"
    return subprocess.run(
        ["npx", "--yes", "tsx", str(src)],
        env=node_env, timeout=180, capture_output=True, text=True,
        cwd=str(NODE_SDK),
    )


def test_node_exec(node_env):
    """Exec with stdout capture + exit code propagation."""
    r = _run_driver(node_env, "e2e_exec.ts")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "HELLO-FROM-NODE" in r.stdout
    assert "EXIT_CODE=42" in r.stdout


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Node SDK exec stdout comes back empty — same drain race as #563. "
        "The copy-in succeeds but the verification exec returns no stdout, "
        "so the driver exits with FATAL. When #563 lands, this xfail flips "
        "xpass-strict — drop the marker then."
    ),
)
def test_node_copy(node_env):
    """Copy in/out round-trip with content verification."""
    r = _run_driver(node_env, "e2e_copy.ts")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "COPY_IN=ok" in r.stdout
    assert "CONTENT_MATCH=ok" in r.stdout
    assert "COPY_OUT=ok" in r.stdout


def test_node_errors(node_env):
    """Error typing: bogus image + nonexistent box."""
    r = _run_driver(node_env, "e2e_errors.ts")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "IMAGE_ERROR=" in r.stdout
    assert "NOT_FOUND=" in r.stdout
