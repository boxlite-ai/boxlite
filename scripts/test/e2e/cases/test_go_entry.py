"""Go SDK entry-point e2e: builds and runs scripts/test/e2e/sdks/go/e2e_basic.go,
asserts a successful box round-trip + runner journal contains the box id.
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

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box

REPO = Path(__file__).resolve().parents[4]
SRC = REPO / "scripts/test/e2e/sdks/go/e2e_basic.go"
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


def _profile():
    return tomllib.loads(
        (Path.home() / ".boxlite/credentials.toml").read_text()
    )["profiles"]["p1"]


def _go_bin():
    return shutil.which("go")


@pytest.fixture(scope="module")
def go_binary():
    if not _go_bin():
        pytest.skip("go toolchain not installed")
    if not SRC.exists():
        pytest.skip(f"{SRC} missing")

    bin_path = Path("/tmp/boxlite_e2e_go")
    try:
        subprocess.run(
            ["go", "build", "-o", str(bin_path), str(SRC)],
            cwd=str(REPO / "sdks/go"),
            check=True, capture_output=True, text=True, timeout=180,
        )
    except subprocess.CalledProcessError as e:
        pytest.skip(f"go build failed: {e.stderr[:600]}")
    return bin_path


def test_go_sdk_create_exec_remove(go_binary):
    p = _profile()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        "BOXLITE_E2E_URL": p["url"],
        "BOXLITE_E2E_API_KEY": p["api_key"],
        "BOXLITE_E2E_PREFIX": p.get("path_prefix") or "",
        "BOXLITE_E2E_IMAGE": "alpine:3.23",
        # CGO dev tag — uses libboxlite.so from the workspace target/release,
        # not a vendored prebuilt one.
        "LD_LIBRARY_PATH": str(REPO / "target/release"),
    }
    r = subprocess.run(
        [str(go_binary)], env=env, timeout=180,
        capture_output=True, text=True,
    )
    assert r.returncode == 0, (
        f"go driver exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )

    m = UUID_RE.search(r.stdout)
    assert m, f"go driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)

    assert "HELLO-FROM-GO" in r.stdout, (
        f"stdout marker missing: {r.stdout!r}"
    )
    assert "EXIT_CODE=0" in r.stdout, (
        f"non-zero exit reported: {r.stdout!r}"
    )

    hits = runner_hits_for_box(journal_since, box_id)
    assert hits >= 1, (
        f"runner journal did not see box {box_id} created by Go SDK"
    )
