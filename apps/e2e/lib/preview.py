"""Direct preview HTTP, WebSocket and CONNECT probes; never prepare a tunnel."""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
import hashlib
from http.client import HTTPConnection, HTTPSConnection
import json
import os
import socket
import ssl
import struct
from urllib.parse import urlsplit


class PreviewHeaders(dict):
    def __repr__(self):
        return "<preview headers redacted>"


class PreviewURL(str):
    def __repr__(self):
        return repr(self.split("?", 1)[0] + ("?[redacted]" if "?" in self else ""))


class Credential(str):
    def __repr__(self):
        return "<credential redacted>"


@dataclass
class Reply:
    status: int
    headers: dict = field(default_factory=dict, repr=False)
    body: bytes = field(default=b"", repr=False)
    cookies: list[str] = field(default_factory=list, repr=False)

    def session_cookie(self):
        matches = [value for value in self.cookies if value.startswith("__Host-boxlite-tunnel-session=")]
        require(len(matches) == 1, "expected exactly one platform session cookie")
        return matches[0]


def require(condition, message):
    # Do not let pytest's assertion rewriting print real tunnel credentials.
    if not condition:
        raise AssertionError(message)


def _http(url, method, headers, body):
    target = urlsplit(url)
    require(target.scheme in ("http", "https") and target.hostname, "invalid preview URL")
    connection_type = HTTPSConnection if target.scheme == "https" else HTTPConnection
    connection = connection_type(target.hostname, target.port, timeout=35)
    try:
        path = target.path or "/"
        if target.query:
            path += "?" + target.query
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read(8 * 1024 * 1024 + 1)
        require(len(data) <= 8 * 1024 * 1024, "HTTP response exceeded probe limit")
        return Reply(response.status, dict((k.lower(), v) for k, v in response.getheaders()), data,
                     response.headers.get_all("Set-Cookie", []))
    finally:
        connection.close()


async def http(url, method="GET", headers=None, body=None):
    """No redirect following, ambient proxy, cookies or platform credentials."""
    url, headers = PreviewURL(url), PreviewHeaders(headers or {})
    return await asyncio.to_thread(_http, url, method, headers, body)


class Wire:
    """A bounded socket exchange, retained only to test established streams."""
    def __init__(self, url):
        self.target = urlsplit(url)
        self.socket = socket.create_connection(
            (self.target.hostname, self.target.port or (443 if self.target.scheme == "https" else 80)), timeout=35,
        )
        try:
            if self.target.scheme == "https":
                context = ssl.create_default_context()
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                self.socket = context.wrap_socket(self.socket, server_hostname=self.target.hostname)
            self.stream = self.socket.makefile("rb")
        except BaseException:
            self.socket.close()
            raise

    def close(self):
        self.stream.close()
        self.socket.close()

    def request(self, method, path, headers=None):
        headers = PreviewHeaders(headers or {})
        fields = PreviewHeaders({"Host": self.target.netloc, **headers})
        require(all("\r" not in k + v and "\n" not in k + v for k, v in fields.items()), "invalid probe header")
        self.socket.sendall((f"{method} {path} HTTP/1.1\r\n" +
                            "".join(f"{k}: {v}\r\n" for k, v in fields.items()) + "\r\n").encode())
        line = self.stream.readline(65537)
        require(line.startswith(b"HTTP/1."), "proxy did not return an HTTP response")
        status = int(line.split(b" ")[1])
        fields, size = {}, len(line)
        while True:
            line = self.stream.readline(65537)
            size += len(line)
            require(line and size <= 65536, "incomplete or oversized proxy headers")
            if line == b"\r\n":
                return Reply(status, fields)
            key, value = line.decode("latin1").split(":", 1)
            fields[key.lower()] = value.strip()

    def exact(self, size):
        data = self.stream.read(size)
        require(len(data) == size, "stream closed before the complete response")
        return data

    def echo(self, payload=b"preview-e2e"):
        require(len(payload) < 126, "probe frame is too large")
        mask = os.urandom(4)
        self.socket.sendall(bytes([0x81, 0x80 | len(payload)]) + mask +
                            bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))
        first, length = self.exact(2)
        require(first == 0x81 and not length & 0x80, "unexpected WebSocket frame")
        if length == 126:
            length = struct.unpack("!H", self.exact(2))[0]
        require(length < 65536, "WebSocket echo exceeds limit")
        return self.exact(length)


def _open_stream(url, transport, headers):
    wire = Wire(url)
    try:
        if transport == "connect":
            reply = wire.request("CONNECT", wire.target.netloc, headers)
        else:
            key = base64.b64encode(os.urandom(16)).decode()
            path = "/ws" + (f"?{wire.target.query}" if wire.target.query else "")
            reply = wire.request("GET", path, {
                **headers, "Upgrade": "websocket", "Connection": "Upgrade",
                "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
            })
            if reply.status == 101:
                expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                require(reply.headers.get("sec-websocket-accept") == expected, "invalid WebSocket accept")
        return wire, reply
    except BaseException:
        wire.close()
        raise


async def open_stream(url, transport, headers=None):
    url, headers = PreviewURL(url), PreviewHeaders(headers or {})
    return await asyncio.to_thread(_open_stream, url, transport, headers)


async def access(url, transport="http", headers=None):
    url = PreviewURL(url)
    headers = PreviewHeaders({"X-BoxLite-Skip-Preview-Warning": "true", **(headers or {})})
    if transport == "http":
        return await http(url, headers=headers)
    wire, reply = await open_stream(url, transport, headers)
    try:
        if transport == "ws" and reply.status == 101:
            reply.body = await asyncio.to_thread(wire.echo)
        elif transport == "connect" and reply.status == 200:
            guest = await asyncio.to_thread(wire.request, "GET", "/", {"Connection": "close"})
            require(guest.status == 200, "CONNECT reached an unexpected guest response")
            length = int(guest.headers["content-length"])
            require(0 <= length < 65536, "CONNECT guest response exceeds limit")
            reply.body = await asyncio.to_thread(wire.exact, length)
        return reply
    finally:
        wire.close()


async def api(ctx, method, path, body=None, token=None):
    token = Credential(token) if token is not None else None
    headers = PreviewHeaders({"Authorization": f"Bearer {ctx.token if token is None else token}"})
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    return await http(ctx.url_for(ctx.v1(path)), method, headers, data)
