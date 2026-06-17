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

from conftest import skip_or_fail_unless_sdk_build_required, path_verify_skipped

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box

REPO = Path(__file__).resolve().parents[4]
SRC = REPO / "scripts/test/e2e/sdks/go/e2e_basic.go"
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


def _go_bin():
    return shutil.which("go")


@pytest.fixture(scope="module")
def go_binary():
    if not _go_bin():
        skip_or_fail_unless_sdk_build_required("go toolchain not installed")
    if not SRC.exists():
        skip_or_fail_unless_sdk_build_required(f"{SRC} missing")

    # The default (prebuilt) CGO directives link `sdks/go/libboxlite.a`, only
    # present after `go run .../cmd/setup` downloads a release artifact — not in
    # CI. Link the workspace build instead via the `boxlite_dev` tag
    # (bridge_cgo_dev.go), whose directives point at `target/debug/libboxlite.a`.
    # The C SDK install stages the archive under `target/release/`, so mirror it
    # into the debug path the dev directives expect.
    dev_lib = REPO / "target/debug/libboxlite.a"
    if not dev_lib.exists():
        release_lib = REPO / "target/release/libboxlite.a"
        if release_lib.exists():
            dev_lib.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(release_lib, dev_lib)

    bin_path = Path("/tmp/boxlite_e2e_go")
    try:
        subprocess.run(
            ["go", "build", "-tags", "boxlite_dev", "-o", str(bin_path), str(SRC)],
            cwd=str(REPO / "sdks/go"),
            check=True, capture_output=True, text=True, timeout=180,
        )
    except subprocess.CalledProcessError as e:
        skip_or_fail_unless_sdk_build_required(f"go build failed: {e.stderr[:600]}")
    return bin_path


def test_go_sdk_create_exec_remove(go_binary):
    p = _profile()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        "BOXLITE_E2E_URL": p["url"],
        "BOXLITE_E2E_API_KEY": p["api_key"],
        "BOXLITE_E2E_PREFIX": p.get("path_prefix") or "",
        "BOXLITE_E2E_IMAGE": os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23"),
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

    m = BOX_ID_RE.search(r.stdout)
    assert m, f"go driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)

    assert "HELLO-FROM-GO" in r.stdout, (
        f"stdout marker missing: {r.stdout!r}"
    )
    assert "EXIT_CODE=0" in r.stdout, (
        f"non-zero exit reported: {r.stdout!r}"
    )

    if not path_verify_skipped():
        hits = runner_hits_for_box(journal_since, box_id)
        assert hits >= 1, (
            f"runner journal did not see box {box_id} created by Go SDK"
        )
