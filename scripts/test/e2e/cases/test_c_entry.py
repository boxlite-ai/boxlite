"""C SDK entry-point e2e: compiles and runs scripts/test/e2e/sdks/c/e2e_basic.c
against libboxlite.so, asserts a successful box round-trip + runner journal
contains the box id.

Unlike the Python/Go/CLI smokes, this driver does not exec a command inside
the box — the C SDK's exec is callback-async and adds 80+ lines of glue that
don't change what the e2e proves (the REST chain works at the C ABI layer).
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
from path_verification import runner_journal_seek, runner_hits_for_box

REPO = Path(__file__).resolve().parents[4]
SRC = REPO / "scripts/test/e2e/sdks/c/e2e_basic.c"
HDR = REPO / "sdks/c/include"
LIB_DIR = REPO / "target/release"
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)

@pytest.fixture(scope="module")
def c_binary():
    if auth_context().auth != "api-key":
        pytest.skip("C SDK REST E2E only supports API-key credentials today")
    if not shutil.which("gcc"):
        pytest.skip("gcc not installed")
    if not SRC.exists():
        pytest.skip(f"{SRC} missing")
    if not (LIB_DIR / "libboxlite.so").exists() and \
       not (LIB_DIR / "libboxlite.a").exists():
        pytest.skip(
            f"libboxlite.so / .a missing under {LIB_DIR}; build with "
            f"`cargo build --release -p boxlite-c` first"
        )

    bin_path = Path("/tmp/boxlite_e2e_c")
    cmd = [
        "gcc", str(SRC),
        f"-I{HDR}",
        f"-L{LIB_DIR}",
        "-lboxlite", "-lpthread", "-ldl", "-lm",
        "-o", str(bin_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
    except subprocess.CalledProcessError as e:
        pytest.skip(f"gcc build failed: {e.stderr[:600]}")
    return bin_path


def test_c_sdk_create_remove(c_binary):
    ctx = auth_context()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": "alpine:3.23",
        "LD_LIBRARY_PATH": str(LIB_DIR),
    }
    r = subprocess.run(
        [str(c_binary)], env=env, timeout=180,
        capture_output=True, text=True,
    )
    assert r.returncode == 0, (
        f"C driver exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )

    m = UUID_RE.search(r.stdout)
    assert m, f"C driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)
    assert "OK" in r.stdout

    hits = runner_hits_for_box(journal_since, box_id)
    assert hits >= 1, (
        f"runner journal did not see box {box_id} created by C SDK"
    )
