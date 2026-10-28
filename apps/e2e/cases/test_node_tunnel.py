"""REST E2E coverage for the Node SDK's public network handle."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import TUNNEL_READ_TO_EOF_XFAIL

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context
from images import default_image
from http_frames import HalfCloseResponseLost, UnexpectedTunnelEOF


REPO = Path(__file__).resolve().parents[3]
NODE_SDK = REPO / "sdks/node"
DRIVER = REPO / "apps/e2e/sdks/node/e2e_tunnel.ts"
TSX = REPO / "apps/node_modules/tsx/dist/cli.mjs"


class NodeEnvironment(dict):
    def __repr__(self):
        return "<Node E2E environment redacted>"


def _has_node_napi_build() -> bool:
    return any(
        directory.exists() and any(directory.rglob("*.node"))
        for directory in (NODE_SDK / "native", NODE_SDK / "dist", NODE_SDK / "npm")
    )


@pytest.fixture(scope="module")
def node_tunnel_env():
    if auth_context().auth != "api-key":
        pytest.skip("Node SDK E2E only supports API-key credentials today")
    if not shutil.which("node") or (not TSX.exists() and not shutil.which("npx")):
        pytest.skip("Node/tsx not installed")
    if not _has_node_napi_build():
        pytest.skip("Node SDK napi binding not built")
    ctx = auth_context()
    return NodeEnvironment({
        **os.environ,
        **ctx.api_key_sdk_env(),
        "BOXLITE_E2E_IMAGE": default_image(),
    })


def _run_node_tunnel(env, scenario):
    # infra-local already installs tsx in apps. Cloud CI only installs the SDK,
    # so retain its existing npx fallback without adding a second dependency.
    command = ["node", str(TSX)] if TSX.exists() else ["npx", "--yes", "tsx"]
    return subprocess.run(
        [*command, str(DRIVER)],
        env={**env, "BOXLITE_E2E_TUNNEL_CASE": scenario},
        timeout=180,
        capture_output=True,
        text=True,
        cwd=str(NODE_SDK),
    )


def _assert_node_tunnel_passes(result, scenario):
    if result.returncode and scenario == "tls-shutdown" and "Error: KNOWN_TLS_SHUTDOWN_EOF" in result.stderr:
        raise UnexpectedTunnelEOF("complete Node response followed by missing TLS close_notify")
    if result.returncode and scenario == "half-close" and "Error: KNOWN_HALF_CLOSE_RESPONSE_LOST" in result.stderr:
        raise HalfCloseResponseLost("working Node tunnel lost response after half-close")
    assert result.returncode == 0, (
        f"exit={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert f"TUNNEL_CASE={scenario}:ok" in result.stdout


def test_node_sdk_tunnel_proxies_http_from_rest_box(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "transport"), "transport")


def test_node_sdk_tunnel_rejects_stopped_box(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "stopped"), "stopped")


@pytest.mark.xfail(
    strict=True,
    raises=HalfCloseResponseLost,
    reason="TCP half-close currently drops the guest response",
)
def test_node_sdk_tunnel_preserves_tcp_half_close(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "half-close"), "half-close")


@TUNNEL_READ_TO_EOF_XFAIL
def test_node_sdk_tunnel_tls_shutdown(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "tls-shutdown"), "tls-shutdown")


def test_node_sdk_private_tunnel_and_revoke(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "private"), "private")


def test_node_sdk_network_policy_update(node_tunnel_env):
    _assert_node_tunnel_passes(_run_node_tunnel(node_tunnel_env, "network"), "network")
