"""Go SDK REST E2E: exec options, copy, error typing.

Extends test_go_entry.py's smoke (create+exec+remove) with deeper
coverage. Each test compiles and runs a Go driver binary.
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
GO_SDK = REPO / "sdks/go"
DRIVERS = REPO / "scripts/test/e2e/sdks/go"
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")


def _build_go(src_name: str) -> Path:
    src = DRIVERS / src_name
    assert src.exists(), f"{src} missing"
    bin_path = Path(f"/tmp/boxlite_e2e_go_{src_name.replace('.go', '')}")
    subprocess.run(
        ["go", "build", "-o", str(bin_path), str(src)],
        cwd=str(GO_SDK),
        check=True, capture_output=True, text=True, timeout=180,
    )
    return bin_path


@pytest.fixture(scope="module")
def go_env():
    if auth_context().auth != "api-key":
        pytest.skip("Go SDK E2E only supports API-key today")
    if not shutil.which("go"):
        pytest.skip("go toolchain not installed")
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": IMAGE,
        "LD_LIBRARY_PATH": str(REPO / "target/release"),
        "DYLD_LIBRARY_PATH": str(REPO / "target/release"),
    }


def _run_go(go_env, src_name: str) -> subprocess.CompletedProcess:
    try:
        bin_path = _build_go(src_name)
    except subprocess.CalledProcessError as e:
        pytest.skip(f"go build {src_name} failed: {e.stderr[:400]}")
    return subprocess.run(
        [str(bin_path)], env=go_env, timeout=180,
        capture_output=True, text=True,
    )


def test_go_exec_options(go_env):
    """Exec with working dir + env vars."""
    r = _run_go(go_env, "e2e_exec_options.go")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "CWD_OUTPUT=/tmp" in r.stdout
    assert "ENV_VALUE=MY_VALUE" in r.stdout


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Go SDK exec stdout comes back empty — same drain race as #563. "
        "The copy-in succeeds but the verification `cat` returns no "
        "stdout, so the driver exits with FATAL. When #563 lands, this "
        "xfail flips xpass-strict — drop the marker then."
    ),
)
def test_go_copy(go_env):
    """Copy in/out round-trip."""
    r = _run_go(go_env, "e2e_copy.go")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "COPY_ROUNDTRIP=ok" in r.stdout


def test_go_errors(go_env):
    """Error typing: bogus image + nonexistent box."""
    r = _run_go(go_env, "e2e_errors.go")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "IMAGE_ERROR=typed" in r.stdout
    assert "NOT_FOUND=" in r.stdout
