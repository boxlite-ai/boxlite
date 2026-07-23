"""REST E2E coverage for the Node SDK's public network handle."""

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
DRIVER = REPO / "scripts/test/e2e/sdks/node/e2e_tunnel.ts"


def _has_node_napi_build() -> bool:
    return any(
        directory.exists() and any(directory.rglob("*.node"))
        for directory in (NODE_SDK / "native", NODE_SDK / "dist", NODE_SDK / "npm")
    )


@pytest.fixture(scope="module")
def node_tunnel_env():
    if auth_context().auth != "api-key":
        pytest.skip("Node SDK E2E only supports API-key credentials today")
    if not shutil.which("npx"):
        pytest.skip("npx not installed")
    if not _has_node_napi_build():
        pytest.skip("Node SDK napi binding not built")
    ctx = auth_context()
    return {
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_SKIP_HALF_CLOSE": "1",
        "BOXLITE_E2E_SKIP_STOPPED_BOX": "1",
        "BOXLITE_E2E_IMAGE": os.environ.get(
            "BOXLITE_E2E_IMAGE",
            "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
        ),
    }


def _run_node_tunnel(env):
    return subprocess.run(
        ["npx", "--yes", "tsx", str(DRIVER)],
        env=env,
        timeout=180,
        capture_output=True,
        text=True,
        cwd=str(NODE_SDK),
    )


def _assert_node_tunnel_passes(result):
    assert result.returncode == 0, (
        f"exit={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "TUNNEL_HTTP=ok" in result.stdout


def test_node_sdk_tunnel_proxies_http_from_rest_box(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env))


@pytest.mark.xfail(
    strict=True,
    reason="stopped boxes may remain reachable through existing tunnel routing",
)
def test_node_sdk_tunnel_rejects_stopped_box(node_tunnel_env):
    env = {**node_tunnel_env}
    env.pop("BOXLITE_E2E_SKIP_STOPPED_BOX")
    _assert_node_tunnel_passes(_run_node_tunnel(env))


@pytest.mark.xfail(
    strict=True,
    reason="TCP half-close currently drops the guest response",
)
def test_node_sdk_tunnel_preserves_tcp_half_close(node_tunnel_env):
    env = {**node_tunnel_env}
    env.pop("BOXLITE_E2E_SKIP_HALF_CLOSE")
    _assert_node_tunnel_passes(_run_node_tunnel(env))
