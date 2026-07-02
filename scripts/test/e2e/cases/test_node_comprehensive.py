"""Node SDK comprehensive e2e tests.

Runs the e2e_comprehensive.ts driver with BOXLITE_E2E_NODE_TEST to
select individual test cases, so failures are reported per-case.
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

REPO = Path(__file__).resolve().parents[4]
NODE_SDK = REPO / "sdks/node"
DRIVER = REPO / "scripts/test/e2e/sdks/node/e2e_comprehensive.ts"
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3")


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
    assert DRIVER.exists(), f"{DRIVER} missing"
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": IMAGE,
    }


def _run(node_env, test_name: str) -> subprocess.CompletedProcess:
    env = {**node_env, "BOXLITE_E2E_NODE_TEST": test_name}
    return subprocess.run(
        ["npx", "--yes", "tsx", str(DRIVER)],
        env=env, timeout=180, capture_output=True, text=True,
        cwd=str(NODE_SDK),
    )


def test_node_stderr_isolation(node_env):
    """Stdout and stderr must not cross-contaminate through napi-rs."""
    r = _run(node_env, "stderr")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "STDERR_ISOLATION=ok" in r.stdout


def test_node_exit_codes(node_env):
    """Exit codes 0, 1, 42, 127 must propagate through napi-rs."""
    r = _run(node_env, "exit_codes")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EXIT_CODES=ok" in r.stdout


def test_node_large_stdout(node_env):
    """4000 lines of stdout must arrive intact through napi-rs."""
    r = _run(node_env, "large_stdout")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "LARGE_STDOUT=ok" in r.stdout


def test_node_env_vars(node_env):
    """Env vars passed through napi-rs exec must be visible in guest."""
    r = _run(node_env, "env_vars")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "ENV_VARS=ok" in r.stdout


def test_node_working_dir(node_env):
    """Working directory override must work through napi-rs."""
    r = _run(node_env, "cwd")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "CWD=ok" in r.stdout


def test_node_empty_output(node_env):
    """`true` must produce zero stdout bytes through napi-rs."""
    r = _run(node_env, "empty")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EMPTY_OUTPUT=ok" in r.stdout


def test_node_concurrent_exec(node_env):
    """Two concurrent execs must not cross their stdout streams."""
    r = _run(node_env, "concurrent")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "CONCURRENT=ok" in r.stdout
