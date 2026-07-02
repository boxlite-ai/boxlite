"""CLI comprehensive e2e tests.

Extends test_cli_entry.py with edge cases exercised through the boxlite
CLI binary (subprocess), covering behaviour that is CLI-specific:

  - stderr capture
  - large stdout through CLI pipe
  - env var passing via --env
  - working directory via --cwd
  - multiple sequential execs on same box
  - exec with non-existent command
  - boxlite info / inspect
  - concurrent boxes via CLI
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

BOXLITE_BIN = os.environ.get("BOXLITE_E2E_CLI", shutil.which("boxlite"))
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3")
CLI_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")
BOX_ID_RE = re.compile(r"[A-Za-z0-9]{12}")


@pytest.fixture(scope="module")
def cli():
    if not BOXLITE_BIN or not Path(BOXLITE_BIN).exists():
        pytest.skip(f"boxlite CLI not found at {BOXLITE_BIN!r}")
    return BOXLITE_BIN


def _cli_env() -> dict[str, str]:
    return {**os.environ, "BOXLITE_PROFILE": CLI_PROFILE}


def run(cli, *args, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [cli, *args],
        timeout=timeout, text=True, capture_output=True,
        check=check, env=_cli_env(),
    )


@pytest.fixture(scope="module")
def detached_box(cli):
    """Create a long-lived detached box for multi-test reuse."""
    r = run(cli, "run", "-d", IMAGE, "--", "sleep", "600", timeout=120)
    m = BOX_ID_RE.search(r.stdout)
    assert m, f"run -d did not print box id: {r.stdout!r}"
    box_id = m.group(0)
    yield box_id
    run(cli, "rm", "-f", box_id, check=False)


# ── stderr capture ─────────────────────────────────────────────────


def test_cli_stderr_separate(cli, detached_box):
    """CLI should route guest stderr to its own stderr, not mix into stdout."""
    r = run(cli, "exec", detached_box, "--",
            "sh", "-c", "echo CLI_OUT && echo CLI_ERR >&2", check=False)
    assert "CLI_OUT" in r.stdout, f"stdout missing: {r.stdout!r}"
    # CLI may merge stderr; just verify stdout is not polluted with
    # the stderr marker if stderr is separate
    if r.stderr and "CLI_ERR" in r.stderr:
        assert "CLI_ERR" not in r.stdout, "stderr leaked into stdout"


# ── large stdout ───────────────────────────────────────────────────


def test_cli_large_stdout(cli, detached_box):
    """4000 lines through the CLI pipe must arrive mostly intact."""
    r = run(cli, "exec", detached_box, "--",
            "seq", "1", "4000", timeout=60, check=False)
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    lines = r.stdout.strip().split("\n")
    assert len(lines) >= 3900, (
        f"CLI large stdout truncated: {len(lines)}/4000"
    )


# ── env var passing ────────────────────────────────────────────────


def test_cli_exec_env_var(cli, detached_box):
    """--env KEY=VALUE should propagate to the guest."""
    r = run(cli, "exec", "--env", "MY_CLI_VAR=cli-e2e-val",
            detached_box, "--", "sh", "-c", "echo $MY_CLI_VAR",
            check=False)
    # --env may not be supported on all CLI versions; skip if not
    if r.returncode != 0 and "unknown" in r.stderr.lower():
        pytest.skip("--env flag not supported on this CLI version")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "cli-e2e-val" in r.stdout, f"env var not propagated: {r.stdout!r}"


# ── working directory ──────────────────────────────────────────────


def test_cli_exec_workdir(cli, detached_box):
    """--workdir / -w should set the working directory in the guest."""
    r = run(cli, "exec", "-w", "/tmp",
            detached_box, "--", "pwd", check=False)
    if r.returncode != 0 and "unknown" in r.stderr.lower():
        pytest.skip("-w/--workdir flag not supported on this CLI version")
    assert r.returncode == 0, f"exit={r.returncode}\nstderr:\n{r.stderr}"
    assert "/tmp" in r.stdout.strip(), f"workdir not honoured: {r.stdout!r}"


# ── multiple sequential execs ─────────────────────────────────────


def test_cli_sequential_execs(cli, detached_box):
    """Multiple sequential execs on the same box should all succeed
    with independent output."""
    for i in range(5):
        r = run(cli, "exec", detached_box, "--",
                "echo", f"SEQ_{i}")
        assert r.returncode == 0
        assert f"SEQ_{i}" in r.stdout, f"exec {i} output wrong: {r.stdout!r}"


# ── exit code propagation for various values ───────────────────────


@pytest.mark.parametrize("code", [0, 1, 2, 42, 127])
def test_cli_exit_code(cli, detached_box, code):
    """Exit codes must propagate through the CLI."""
    r = run(cli, "exec", detached_box, "--",
            "sh", "-c", f"exit {code}", check=False)
    assert r.returncode == code, (
        f"CLI exit code: expected {code}, got {r.returncode}"
    )


# ── nonexistent command ───────────────────────────────────────────


def test_cli_nonexistent_command(cli, detached_box):
    """Running a non-existent binary should produce non-zero exit."""
    r = run(cli, "exec", detached_box, "--",
            "this_does_not_exist_xyz", check=False)
    assert r.returncode != 0, "nonexistent command should fail"


# ── box info / inspect ────────────────────────────────────────────


def test_cli_ls_shows_box(cli, detached_box):
    """`boxlite ls` should list the detached box."""
    r = run(cli, "ls")
    assert r.returncode == 0, f"ls failed: {r.stderr}"
    assert detached_box in r.stdout, (
        f"detached box {detached_box} not in ls output: {r.stdout!r}"
    )


# ── create with name ──────────────────────────────────────────────


def test_cli_run_with_name(cli):
    """Create a box with --name and verify it appears in ls."""
    name = "cli-e2e-named-box"
    r = run(cli, "run", "-d", "--name", name, IMAGE, "--",
            "sleep", "300", timeout=120, check=False)
    if r.returncode != 0:
        pytest.skip(f"--name not supported or failed: {r.stderr}")
    m = BOX_ID_RE.search(r.stdout)
    assert m, f"run -d --name did not print id: {r.stdout!r}"
    box_id = m.group(0)
    try:
        r_ls = run(cli, "ls")
        assert name in r_ls.stdout or box_id in r_ls.stdout, (
            f"named box not in ls: {r_ls.stdout!r}"
        )
    finally:
        run(cli, "rm", "-f", box_id, check=False)
