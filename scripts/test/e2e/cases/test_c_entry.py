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
import tomllib
from pathlib import Path

import pytest

from conftest import skip_or_fail_unless_sdk_build_required, path_verify_skipped

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box

REPO = Path(__file__).resolve().parents[4]
SRC = REPO / "scripts/test/e2e/sdks/c/e2e_basic.c"
HDR = REPO / "sdks/c/include"
LIB_DIR = REPO / "target/release"
# Box ids are server-issued and opaque: the local runtime mints 12-char
# Base62, but a REST server may return a ULID or UUID (see BoxID docs,
# src/boxlite/src/runtime/id.rs).
BOX_ID_RE = re.compile(
    r"\b("
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"  # UUID
    r"|[0-9A-HJKMNP-TV-Z]{26}"                                       # ULID
    r"|[0-9A-Za-z]{12}"                                              # 12-char Base62
    r")\b"
)


def _profile():
    name = os.environ.get("BOXLITE_E2E_PROFILE", "p1")
    return tomllib.loads(
        (Path.home() / ".boxlite/credentials.toml").read_text()
    )["profiles"][name]


@pytest.fixture(scope="module")
def c_binary():
    if not shutil.which("gcc"):
        skip_or_fail_unless_sdk_build_required("gcc not installed")
    if not SRC.exists():
        skip_or_fail_unless_sdk_build_required(f"{SRC} missing")
    if not (LIB_DIR / "libboxlite.so").exists() and \
       not (LIB_DIR / "libboxlite.a").exists():
        skip_or_fail_unless_sdk_build_required(
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
        skip_or_fail_unless_sdk_build_required(f"gcc build failed: {e.stderr[:600]}")
    return bin_path


def test_c_sdk_create_remove(c_binary):
    p = _profile()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        "BOXLITE_E2E_URL": p["url"],
        "BOXLITE_E2E_API_KEY": p["api_key"],
        "BOXLITE_E2E_PREFIX": p.get("path_prefix") or "",
        "BOXLITE_E2E_IMAGE": os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23"),
        "LD_LIBRARY_PATH": str(LIB_DIR),
    }
    r = subprocess.run(
        [str(c_binary)], env=env, timeout=180,
        capture_output=True, text=True,
    )
    assert r.returncode == 0, (
        f"C driver exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )

    m = BOX_ID_RE.search(r.stdout)
    assert m, f"C driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)
    assert "OK" in r.stdout

    if not path_verify_skipped():
        hits = runner_hits_for_box(journal_since, box_id)
        assert hits >= 1, (
            f"runner journal did not see box {box_id} created by C SDK"
        )
