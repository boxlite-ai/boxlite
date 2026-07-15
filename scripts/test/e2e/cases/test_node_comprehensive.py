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
    r = subprocess.run(
        ["npx", "--yes", "tsx", str(DRIVER)],
        env=env, timeout=180, capture_output=True, text=True,
        cwd=str(NODE_SDK),
    )
    # Echo the driver output so each Node case is visible in the CI log even
    # on success (pytest runs with -s). Without this the subprocess output is
    # swallowed and the log only shows the pytest PASSED line.
    print(f"\n──── node driver: {test_name} (exit={r.returncode}) ────")
    if r.stdout:
        print(r.stdout.rstrip())
    if r.stderr:
        print(f"[stderr] {r.stderr.rstrip()}")
    return r


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


def test_node_signal_exit(node_env):
    """A signal-killed process reports a nonzero (signal) exit code."""
    r = _run(node_env, "signal_exit")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "SIGNAL_EXIT=ok" in r.stdout


def test_node_large_stderr(node_env):
    """4000 lines of stderr must arrive intact through napi-rs."""
    r = _run(node_env, "large_stderr")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "LARGE_STDERR=ok" in r.stdout


def test_node_many_env(node_env):
    """50 env vars must all propagate through napi-rs exec."""
    r = _run(node_env, "many_env")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "MANY_ENV=ok" in r.stdout


def test_node_unicode(node_env):
    """Unicode/multibyte stdout must survive the napi-rs boundary."""
    r = _run(node_env, "unicode")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "UNICODE=ok" in r.stdout


def test_node_copy_roundtrip(node_env):
    """copyIn then copyOut must return identical text content."""
    r = _run(node_env, "copy_roundtrip")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "COPY_ROUNDTRIP=ok" in r.stdout


def test_node_copy_binary(node_env):
    """A binary file (all 256 byte values) must survive copyIn/copyOut."""
    r = _run(node_env, "copy_binary")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "COPY_BINARY=ok" in r.stdout


def test_node_copy_large(node_env):
    """A 1 MiB file must copy in and out with a matching sha256."""
    r = _run(node_env, "copy_large")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "COPY_LARGE=ok" in r.stdout


def test_node_copy_nested(node_env):
    """copyIn/copyOut into a deeply nested directory path."""
    r = _run(node_env, "copy_nested")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "COPY_NESTED=ok" in r.stdout


def test_node_lifecycle_stop_start(node_env):
    """Data written before stop must survive a stop/start cycle."""
    r = _run(node_env, "lifecycle_stop_start")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "LIFECYCLE_STOP_START=ok" in r.stdout


def test_node_box_info(node_env):
    """box.info() and rt.getInfo() must carry the box id and name."""
    r = _run(node_env, "box_info")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "BOX_INFO=ok" in r.stdout


def test_node_two_boxes_isolated(node_env):
    """Two boxes must have independent filesystems."""
    r = _run(node_env, "two_boxes_isolated")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "TWO_BOXES_ISOLATED=ok" in r.stdout


def test_node_list_info(node_env):
    """rt.listInfo() must include a freshly created box."""
    r = _run(node_env, "list_info")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "LIST_INFO=ok" in r.stdout


def test_node_exec_stdin(node_env):
    """Writing to exec stdin and closing must echo through `cat`."""
    r = _run(node_env, "exec_stdin")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EXEC_STDIN=ok" in r.stdout


def test_node_exec_kill(node_env):
    """ex.kill() must terminate a running exec (nonzero exit)."""
    r = _run(node_env, "exec_kill")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EXEC_KILL=ok" in r.stdout


def test_node_exec_signal(node_env):
    """ex.signal(SIGTERM) must terminate a running exec."""
    r = _run(node_env, "exec_signal")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EXEC_SIGNAL=ok" in r.stdout


def test_node_exec_tty(node_env):
    """Exec with tty=true (PTY path) must return output."""
    r = _run(node_env, "exec_tty")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "EXEC_TTY=ok" in r.stdout


def test_node_copyout_missing(node_env):
    """copyOut of a missing path must reject through napi-rs."""
    r = _run(node_env, "copyout_missing")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "COPYOUT_MISSING=ok" in r.stdout


def test_node_custom_cpus(node_env):
    """A box created with cpus=2 must see 2 CPUs in the guest."""
    r = _run(node_env, "custom_cpus")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "CUSTOM_CPUS=ok" in r.stdout


def test_node_get_returns_box(node_env):
    """rt.get(id) must return a usable box handle."""
    r = _run(node_env, "get_returns_box")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "GET_RETURNS_BOX=ok" in r.stdout


def test_node_remove_idempotent(node_env):
    """Removing an already-removed box must reject."""
    r = _run(node_env, "remove_idempotent")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "REMOVE_IDEMPOTENT=ok" in r.stdout


def test_node_get_nonexistent(node_env):
    """getInfo of a nonexistent id must not return a box (rejects or null)."""
    r = _run(node_env, "get_nonexistent")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "GET_NONEXISTENT=ok" in r.stdout


def test_node_resize_tty(node_env):
    """resizeTty on a tty exec must succeed through napi-rs."""
    r = _run(node_env, "resize_tty")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "RESIZE_TTY=ok" in r.stdout


def test_node_resize_non_tty(node_env):
    """resizeTty on a non-tty exec must reject through napi-rs."""
    r = _run(node_env, "resize_non_tty")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "RESIZE_NON_TTY=ok" in r.stdout


def test_node_box_name(node_env):
    """box.name() must return the name the box was created with."""
    r = _run(node_env, "box_name")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "BOX_NAME=ok" in r.stdout
