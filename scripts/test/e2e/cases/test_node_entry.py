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
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context
from path_verification import runner_journal_seek, runner_hits_for_box

REPO = Path(__file__).resolve().parents[4]
SRC = REPO / "scripts/test/e2e/sdks/node/e2e_basic.ts"
NODE_SDK = REPO / "sdks/node"
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)

def _has_node_napi_build() -> bool:
    """The napi binding produces sdks/node/native/*.node OR
    sdks/node/dist/*.node — either is fine."""
    for p in [NODE_SDK / "native", NODE_SDK / "dist", NODE_SDK / "npm"]:
        if p.exists() and any(p.rglob("*.node")):
            return True
    return False


@pytest.fixture(scope="module")
def node_runner():
    if auth_context().auth != "api-key":
        pytest.skip("Node SDK REST E2E only supports API-key credentials today")
    if not shutil.which("node"):
        pytest.skip("node not installed")
    if not shutil.which("npx"):
        pytest.skip("npx not installed")
    if not SRC.exists():
        pytest.skip(f"{SRC} missing")
    if not _has_node_napi_build():
        pytest.skip(
            "Node SDK napi binding not built — run "
            "`cd sdks/node && yarn install && yarn build:native` first"
        )
    return SRC


def test_node_sdk_create_exec_remove(node_runner):
    ctx = auth_context()
    journal_since = runner_journal_seek()

    env = {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": "alpine:3.23",
    }
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

    m = UUID_RE.search(r.stdout)
    assert m, f"node driver did not print BOX_ID: {r.stdout!r}"
    box_id = m.group(0)

    assert "OK" in r.stdout

    hits = runner_hits_for_box(journal_since, box_id)
    assert hits >= 1, (
        f"runner journal did not see box {box_id} created by Node SDK"
    )
