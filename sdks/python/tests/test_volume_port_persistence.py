"""Integration test: read-write host volume persistence + host port mapping.

This pins a direct-SDK capability that the REST surface deliberately does NOT
expose (see ``scripts/test/e2e/cases/test_volume_readonly.py``): a long-lived
box that

  1. mounts a **read-write** host directory and writes through to the host,
  2. publishes a **host port** that reaches a server running inside the box, and
  3. keeps the volume's data across a box restart.

``apps/infra-local`` (the local dev stack) is the real-world user of exactly
this shape — e.g. the postgres box binds ``25432:5432`` over a writable
``.apps-local/data/pg`` volume. Its bespoke pytest suite was removed, so this
SDK-layer test preserves the coverage in the correct place.

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun + Hypervisor.framework)
"""

from __future__ import annotations

import http.client
import os
import shutil
import socket
import tempfile
import time

import pytest

import boxlite

GUEST_MOUNT = "/data"
GUEST_PORT = 8000
MARKER = "persisted-vol-port"  # no trailing newline → exact byte compare


@pytest.fixture
def runtime(shared_sync_runtime):
    """Reuse the shared sync runtime (one runtime per ~/.boxlite flock)."""
    return shared_sync_runtime


def _free_host_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _sh(sandbox, command: str) -> tuple[int, str]:
    """Run a shell command in the guest; return (exit_code, merged stdout)."""
    execution = sandbox.exec("sh", ["-c", command])
    stdout = "".join(list(execution.stdout()))
    return execution.wait().exit_code, stdout


def _get_when_ready(host_port: int, path: str, *, timeout_s: float = 20.0) -> str:
    """Poll the host-mapped port until the in-box server answers; return body."""
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        conn = http.client.HTTPConnection("127.0.0.1", host_port, timeout=2.0)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read().decode()
            if resp.status == 200:
                return body
            last_err = AssertionError(f"status {resp.status}")
        except OSError as e:  # not listening yet / port-forward warming up
            last_err = e
        finally:
            conn.close()
        time.sleep(0.5)
    raise AssertionError(f"host port {host_port} never served {path}: {last_err!r}")


@pytest.mark.integration
class TestVolumePortPersistence:
    """Direct-SDK: RW host volume persists + a mapped host port reaches the box."""

    def test_rw_volume_persists_and_port_is_reachable(self, runtime):
        host_dir = tempfile.mkdtemp(prefix="bl_vol_port_")
        host_port = _free_host_port()

        def _box(ports):
            return runtime.create(
                boxlite.BoxOptions(
                    image="alpine:latest",
                    volumes=[(host_dir, GUEST_MOUNT)],  # 2-tuple → read-write
                    ports=ports,
                    memory_mib=512,
                    cpus=1,
                    auto_remove=False,
                )
            )

        # ── Box 1: write through the RW volume + serve it on a mapped port ──
        sandbox = _box([(host_port, GUEST_PORT)])
        try:
            rc, _ = _sh(sandbox, f"printf '%s' '{MARKER}' > {GUEST_MOUNT}/marker.txt")
            assert rc == 0, "guest write to read-write volume failed"

            # (a) write-through: the host directory sees the byte the box wrote.
            with open(os.path.join(host_dir, "marker.txt")) as f:
                assert f.read() == MARKER, "RW volume did not write through to host"

            # (b) host port mapping: busybox httpd in the box, reached from host.
            rc, _ = _sh(sandbox, f"httpd -p {GUEST_PORT} -h {GUEST_MOUNT}")
            assert rc == 0, "failed to start in-box httpd"
            assert _get_when_ready(host_port, "/marker.txt") == MARKER
        finally:
            sandbox.stop()

        # ── Box 2: a fresh box on the same host volume sees the persisted data ──
        sandbox2 = _box([])
        try:
            rc, out = _sh(sandbox2, f"cat {GUEST_MOUNT}/marker.txt")
            assert rc == 0 and out == MARKER, (
                f"volume data did not persist across restart: rc={rc} out={out!r}"
            )
        finally:
            sandbox2.stop()
            shutil.rmtree(host_dir, ignore_errors=True)
