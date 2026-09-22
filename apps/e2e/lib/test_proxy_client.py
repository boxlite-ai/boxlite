"""Client framing tests only; these do not qualify a BoxLite deployment."""

import base64
import hashlib
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from proxy_client import ProxyClient


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.received.append(dict(self.headers))
        if self.path == "/redirect":
            self.send_response(307)
            self.send_header("Location", "/unexpected-follow")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/ws":
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(
                hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                ).digest()
            ).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            first, second = self.rfile.read(2)
            assert first == 0x81 and second & 0x80
            mask = self.rfile.read(4)
            data = self.rfile.read(second & 0x7F)
            payload = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
            self.wfile.write(bytes([0x81, len(payload)]) + payload)
            self.wfile.flush()
            self.close_connection = True
        else:
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    def log_message(self, *_):
        pass


class ProxyClientTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.received = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join, 5)
        self.addCleanup(self.server.shutdown)
        self.host = f"app-example.proxy.test:{self.server.server_port}"
        self.env = patch.dict(
            os.environ, {"BOXLITE_E2E_PROXY_CONNECT_HOST": "127.0.0.1"}
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_http_preserves_issued_host_and_preview_token(self):
        client = ProxyClient(f"http://{self.host}", "fixture-only-preview-token")
        self.assertEqual(client.get(), (200, b"ok"))
        self.assertEqual(self.server.received[0]["Host"], self.host)
        self.assertEqual(
            self.server.received[0]["X-BoxLite-Preview-Token"],
            "fixture-only-preview-token",
        )

    def test_private_redirect_is_not_followed(self):
        self.assertEqual(
            ProxyClient(f"http://{self.host}").get("/redirect"), (307, b"")
        )
        self.assertEqual(len(self.server.received), 1)

    def test_websocket_handshake_and_masked_frame(self):
        self.assertEqual(
            ProxyClient(f"http://{self.host}").websocket_echo(b"probe"), b"probe"
        )
        self.assertEqual(self.server.received[0]["Host"], self.host)

    def test_invalid_origins_are_rejected(self):
        for url in (
            "file:///tmp/test",
            "https://user:password@example.com",
            "http://example.com/path",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                ProxyClient(url)


if __name__ == "__main__":
    unittest.main()
