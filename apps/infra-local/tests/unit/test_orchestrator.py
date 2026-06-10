"""Unit tests for orchestrator helpers that can be tested in isolation."""

from __future__ import annotations

import http.server
import socketserver
import threading

import pytest

from boxlite_local.orchestrator import _http_probe, _is_already_running_error


# ─── _http_probe ─────────────────────────────────────────────────────────

class _Handler200(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_):  # silence noise during tests
        pass


class _Handler500(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(500)
        self.end_headers()

    def log_message(self, *_):
        pass


def _serve(handler_cls) -> tuple[socketserver.TCPServer, threading.Thread]:
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler_cls)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t


def test_http_probe_returns_true_on_2xx():
    srv, _ = _serve(_Handler200)
    try:
        port = srv.server_address[1]
        assert _http_probe(f"http://127.0.0.1:{port}/") is True
    finally:
        srv.shutdown()
        srv.server_close()


def test_http_probe_returns_false_on_5xx():
    srv, _ = _serve(_Handler500)
    try:
        port = srv.server_address[1]
        assert _http_probe(f"http://127.0.0.1:{port}/") is False
    finally:
        srv.shutdown()
        srv.server_close()


def test_http_probe_returns_false_when_unreachable():
    assert _http_probe("http://127.0.0.1:1/") is False


# ─── _is_already_running_error ──────────────────────────────────────────

def test_already_running_predicate_matches_known_patterns():
    assert _is_already_running_error(Exception("box is already running")) is True
    assert _is_already_running_error(Exception("Box already started")) is True
    assert _is_already_running_error(Exception("ERROR: already exists")) is True


def test_already_running_predicate_rejects_unrelated_errors():
    assert _is_already_running_error(Exception("image pull failed")) is False
    assert _is_already_running_error(Exception("out of memory")) is False
    assert _is_already_running_error(Exception("")) is False
    assert _is_already_running_error(RuntimeError("network timeout")) is False


# ─── _wait_healthy_exec callable dispatch ────────────────────────────────

import asyncio

from boxlite_local.config import InfraConfig
from boxlite_local.orchestrator import _wait_healthy_exec
from boxlite_local.types import HealthCheck


class _FakeExecution:
    def __init__(self, exit_code):
        self._rc = exit_code

    def stdout(self):
        async def _it():
            if False:
                yield ""
        return _it()

    def stderr(self):
        async def _it():
            if False:
                yield ""
        return _it()

    async def wait(self):
        class _R: pass
        r = _R()
        r.exit_code = self._rc
        return r


class _FakeBox:
    def __init__(self, exit_code: int = 0):
        self.calls: list[tuple[str, list[str]]] = []
        self._rc = exit_code

    async def exec(self, command, args, env=None):
        self.calls.append((command, list(args)))
        return _FakeExecution(self._rc)


def test_wait_healthy_exec_accepts_literal_list():
    box = _FakeBox(exit_code=0)
    cfg = InfraConfig()
    hc = HealthCheck(exec=["echo", "hello"], retries=1, interval_s=0.0, timeout_s=1.0)
    asyncio.run(_wait_healthy_exec(box, hc, label="t", config=cfg))
    assert box.calls == [("echo", ["hello"])]


def test_wait_healthy_exec_accepts_callable_with_config():
    box = _FakeBox(exit_code=0)
    cfg = InfraConfig(pg_user="alice", pg_db="appdb")
    hc = HealthCheck(
        exec=lambda c: ["pg_isready", "-U", c.pg_user, "-d", c.pg_db],
        retries=1, interval_s=0.0, timeout_s=1.0,
    )
    asyncio.run(_wait_healthy_exec(box, hc, label="t", config=cfg))
    assert box.calls == [("pg_isready", ["-U", "alice", "-d", "appdb"])]


def test_build_box_options_resolves_callable_cmd():
    """ServiceSpec.cmd may be a callable returning the cmd list (used by Caddy in 3c)."""
    from boxlite_local.orchestrator import build_box_options
    from boxlite_local.types import ServiceSpec

    spec = ServiceSpec(
        name="t",
        image="alpine:3.20",
        cmd=lambda cfg: ["sh", "-c", f"echo hub={cfg.host_hub}"],
    )
    cfg = InfraConfig(host_hub="custom.host")
    opts = build_box_options(spec, cfg)
    # The cmd attribute on BoxOptions is a list[str] — assert resolution happened.
    assert opts.cmd == ["sh", "-c", "echo hub=custom.host"]
