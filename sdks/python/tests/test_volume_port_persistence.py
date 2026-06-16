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

The in-box server is the box's own long-lived ``cmd`` (a foreground
``python3 -m http.server`` over the mounted volume) — mirroring how infra-local
runs each service as the box's main process, rather than backgrounding a daemon
via ``exec`` (whose lifetime is the exec session, not the box).

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
# python:3-alpine ships python3 + sh; `python3 -m http.server` is a rock-solid
# static server (alpine's base busybox omits the httpd applet).
IMAGE = "python:3-alpine"


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


def _serve_cmd(*, write_marker: bool) -> list[str]:
    """sh -c script: (optionally) write the marker into the RW volume, then
    `exec` a foreground HTTP server over it as the box's main process."""
    pre = f"printf '%s' '{MARKER}' > {GUEST_MOUNT}/marker.txt; " if write_marker else ""
    serve = f"exec python3 -m http.server {GUEST_PORT} --bind 0.0.0.0 --directory {GUEST_MOUNT}"
    return ["-c", pre + serve]


def _get_when_ready(host_port: int, path: str, *, timeout_s: float = 30.0) -> str:
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

        def _serve_on_free_port(*, write_marker: bool, attempts: int = 4):
            """Create + start a server box on a freshly-picked host port, retrying on
            failure. `_free_host_port()` releases the port before the box binds it, so
            another process can win that TOCTOU window — recover by trying a new port."""
            last_err: Exception | None = None
            for _ in range(attempts):
                port = _free_host_port()
                box = runtime.create(
                    boxlite.BoxOptions(
                        image=IMAGE,
                        volumes=[(host_dir, GUEST_MOUNT)],  # 2-tuple → read-write
                        ports=[(port, GUEST_PORT)],
                        memory_mib=512,
                        cpus=1,
                        auto_remove=False,
                        entrypoint=["sh"],
                        cmd=_serve_cmd(write_marker=write_marker),
                    )
                )
                try:
                    box.start()
                    return box, port
                except Exception as e:
                    # most likely the host port was taken between pick + bind
                    last_err = e
                    try:
                        box.stop()
                    except Exception:
                        # Best-effort cleanup: if start() failed, stop() may also fail;
                        # ignore and continue retrying with a new port.
                        pass
            raise AssertionError(
                f"could not start a server box on a free host port: {last_err!r}"
            )

        # ── Box 1: write through the RW volume, then serve it on a mapped port ──
        box, host_port = _serve_on_free_port(write_marker=True)
        try:
            # (a) host port mapping: the in-box server is reached from the host,
            # and (b) it serves the byte the box wrote into the RW volume.
            assert _get_when_ready(host_port, "/marker.txt") == MARKER
            # write-through is visible on the host directory too.
            with open(os.path.join(host_dir, "marker.txt")) as f:
                assert f.read() == MARKER, "RW volume did not write through to host"
        finally:
            box.stop()

        # ── Box 2: a fresh box on the same host volume serves the persisted data ──
        box2, host_port2 = _serve_on_free_port(write_marker=False)
        try:
            assert _get_when_ready(host_port2, "/marker.txt") == MARKER, (
                "volume data did not persist across a box restart"
            )
        finally:
            box2.stop()
            shutil.rmtree(host_dir, ignore_errors=True)
