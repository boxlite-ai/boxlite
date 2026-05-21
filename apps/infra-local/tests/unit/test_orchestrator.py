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
