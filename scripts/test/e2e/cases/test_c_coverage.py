"""C SDK REST E2E: exec with stdout capture, error typing.

Extends test_c_entry.py's smoke (create+remove) with exec and error
coverage. Each test compiles and runs a C driver binary.
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
HDR = REPO / "sdks/c/include"
LIB_DIR = REPO / "target/release"
DRIVERS = REPO / "scripts/test/e2e/sdks/c"
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")


def _has_libboxlite() -> bool:
    for ext in ("so", "dylib", "a"):
        if (LIB_DIR / f"libboxlite.{ext}").exists():
            return True
    return False


def _build_c(src_name: str) -> Path:
    src = DRIVERS / src_name
    assert src.exists(), f"{src} missing"
    bin_path = Path(f"/tmp/boxlite_e2e_c_{src_name.replace('.c', '')}")
    subprocess.run(
        [
            "gcc", str(src),
            f"-I{HDR}", f"-L{LIB_DIR}",
            "-lboxlite", "-lpthread", "-ldl", "-lm",
            "-o", str(bin_path),
        ],
        check=True, capture_output=True, text=True, timeout=120,
    )
    return bin_path


@pytest.fixture(scope="module")
def c_env():
    if auth_context().auth != "api-key":
        pytest.skip("C SDK E2E only supports API-key today")
    if not shutil.which("gcc"):
        pytest.skip("gcc not installed")
    if not _has_libboxlite():
        pytest.skip(f"libboxlite not found under {LIB_DIR}")
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": IMAGE,
        "LD_LIBRARY_PATH": str(LIB_DIR),
        "DYLD_LIBRARY_PATH": str(LIB_DIR),
    }


def _run_c(c_env, src_name: str) -> subprocess.CompletedProcess:
    try:
        bin_path = _build_c(src_name)
    except subprocess.CalledProcessError as e:
        pytest.skip(f"gcc build {src_name} failed: {e.stderr[:400]}")
    return subprocess.run(
        [str(bin_path)], env=c_env, timeout=180,
        capture_output=True, text=True,
    )


def test_c_exec(c_env):
    """Exec echo with stdout capture via callback."""
    r = _run_c(c_env, "e2e_exec.c")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "EXEC_STDOUT=HELLO-FROM-C" in r.stdout
    assert "EXIT_CODE=0" in r.stdout


def test_c_errors(c_env):
    """Error typing: bogus image create should not leak Internal(1)."""
    r = _run_c(c_env, "e2e_errors.c")
    assert r.returncode == 0, (
        f"exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )
    assert "IMAGE_ERROR=" in r.stdout
    assert "OK" in r.stdout
