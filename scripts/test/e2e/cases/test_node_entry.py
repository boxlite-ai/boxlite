"""Node SDK entry-point e2e: builds and runs scripts/test/e2e/sdks/node/e2e_basic.ts
against the local @boxlite-ai/boxlite napi build, asserts a successful box
round-trip + runner journal contains the box id.

Skips cleanly if the Node SDK's napi binding hasn't been built locally
(yarn install + napi build produces sdks/node/native/*.node).
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
SRC = REPO / "scripts/test/e2e/sdks/node/e2e_basic.ts"
NODE_SDK = REPO / "sdks/node"
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


def _napi_binding():
    """Absolute path to the built napi `.node`, or None. The CI install stages
    it under sdks/node/npm/<triple>/, where the generated native/boxlite.js
    loader won't find it (it tries ./boxlite.<triple>.node then the npm package
    name). NAPI_RS_NATIVE_LIBRARY_PATH points the loader straight at it."""
    for p in [NODE_SDK / "native", NODE_SDK / "npm", NODE_SDK / "dist"]:
        if p.exists():
            hit = next(iter(sorted(p.rglob("*.node"))), None)
            if hit:
                return hit
    return None


def _has_node_napi_build() -> bool:
    return _napi_binding() is not None


@pytest.fixture(scope="module")
def node_runner():
    if not shutil.which("node"):
        skip_or_fail_unless_sdk_build_required("node not installed")
    if not shutil.which("npx"):
        skip_or_fail_unless_sdk_build_required("npx not installed")
    if not SRC.exists():
        skip_or_fail_unless_sdk_build_required(f"{SRC} missing")
    if not _has_node_napi_build():
        skip_or_fail_unless_sdk_build_required(
            "Node SDK napi binding not built — run "
            "`cd sdks/node && yarn install && yarn build:native` first"
        )
    return SRC


def test_node_sdk_create_exec_remove(node_runner):
    p = _profile()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        "BOXLITE_E2E_URL": p["url"],
        "BOXLITE_E2E_API_KEY": p["api_key"],
        "BOXLITE_E2E_PREFIX": p.get("path_prefix") or "",
        "BOXLITE_E2E_IMAGE": os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23"),
    }
    # Point the napi loader straight at the staged binary; boxlite.js honors
    # NAPI_RS_NATIVE_LIBRARY_PATH before its ./<triple>.node / npm-package
    # resolution, which don't match the install layout.
    binding = _napi_binding()
    if binding:
        env["NAPI_RS_NATIVE_LIBRARY_PATH"] = str(binding)
    # Use npx tsx to run the .ts directly without a separate compile step.
    # tsx is bundled with the apps workspace.
    r = subprocess.run(
        ["npx", "--yes", "tsx", str(node_runner)],
        env=env, timeout=180, capture_output=True, text=True,
        cwd=str(NODE_SDK),
    )
    assert r.returncode == 0, (
        f"node driver exit={r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    )

    m = BOX_ID_RE.search(r.stdout)
    assert m, f"node driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)

    assert "OK" in r.stdout

    if not path_verify_skipped():
        hits = runner_hits_for_box(journal_since, box_id)
        assert hits >= 1, (
            f"runner journal did not see box {box_id} created by Node SDK"
        )
