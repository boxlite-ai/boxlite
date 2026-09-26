"""HTTP/WebSocket client for deployed preview proxies, without redirect following."""

from __future__ import annotations

import base64
import hashlib
import http.client
import os
import socket
import ssl
from urllib.parse import urlsplit


class ProxyClient:
    """Preserve issued Host/SNI; optionally dial loopback for local deployment tests."""

    def __init__(self, url: str, token: str | None = None):
        self.url = urlsplit(url)
        if self.url.scheme not in ("http", "https") or not self.url.hostname:
            raise ValueError("Endpoint URL must be an HTTP(S) URL")
        if self.url.username or self.url.password or self.url.path not in ("", "/"):
            raise ValueError("Endpoint URL must be an origin without credentials")
        self.token = token

    def _connect(self):
        hostname = self.url.hostname
        address = os.environ.get("BOXLITE_E2E_PROXY_CONNECT_HOST", hostname)
        port = self.url.port or (443 if self.url.scheme == "https" else 80)
        connection = socket.create_connection((address, port), timeout=15)
        if self.url.scheme == "https":
            try:
                connection = ssl.create_default_context().wrap_socket(
                    connection, server_hostname=hostname
                )
            except BaseException:
                connection.close()
                raise
        return connection

    def _headers(self):
        headers = {
            "Host": self.url.netloc,
            "X-BoxLite-Skip-Preview-Warning": "true",
        }
        if self.token:
            headers["X-BoxLite-Preview-Token"] = self.token
        return headers

    def get(self, path="/") -> tuple[int, bytes]:
        connection = http.client.HTTPConnection(self.url.hostname, timeout=15)
        try:
            connection.sock = self._connect()
            connection.request("GET", path, headers=self._headers())
            response = connection.getresponse()
            return response.status, response.read(1024 * 1024)
        finally:
            connection.close()

    def websocket_echo(self, payload: bytes) -> bytes:
        if len(payload) > 125:
            raise ValueError("The fixture uses small WebSocket frames")
        key = base64.b64encode(os.urandom(16)).decode()
        headers = {
            **self._headers(),
            "Connection": "Upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": key,
        }
        with self._connect() as connection:
            request = (
                "GET /ws HTTP/1.1\r\n"
                + "".join(f"{name}: {value}\r\n" for name, value in headers.items())
                + "\r\n"
            )
            connection.sendall(request.encode())
            with connection.makefile("rb") as reader:
                status = reader.readline(8192)
                if not status.startswith(b"HTTP/1.1 101 "):
                    raise AssertionError(f"WebSocket upgrade failed: {status!r}")
                response_headers = {}
                for _ in range(100):
                    line = reader.readline(8192)
                    if line == b"\r\n":
                        break
                    if not line:
                        raise ConnectionError("Incomplete WebSocket handshake")
                    name, value = line.decode().split(":", 1)
                    response_headers[name.lower()] = value.strip()
                else:
                    raise AssertionError("Oversized WebSocket handshake")
                expected = base64.b64encode(
                    hashlib.sha1(
                        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                    ).digest()
                ).decode()
                assert response_headers.get("sec-websocket-accept") == expected
                assert response_headers.get("upgrade", "").lower() == "websocket"
                mask = os.urandom(4)
                connection.sendall(
                    bytes([0x81, 0x80 | len(payload)])
                    + mask
                    + bytes(
                        value ^ mask[index % 4] for index, value in enumerate(payload)
                    )
                )
                frame = reader.read(2)
                assert len(frame) == 2 and frame[0] == 0x81 and frame[1] <= 125, frame
                response = reader.read(frame[1])
                assert len(response) == frame[1], "Truncated WebSocket response"
                return response
