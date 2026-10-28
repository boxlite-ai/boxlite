import base64
import hashlib
import json
import socketserver
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


PORT = int(sys.argv[1])
MARKER = sys.argv[2].encode()
LARGE_BODY = MARKER + b":" + (b"x" * (2 * 1024 * 1024))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/ws":
            self._websocket_echo()
            return
        body = LARGE_BODY if path in ("/large", "/slow") else self.server.marker
        if path == "/inspect":
            body = json.dumps({"marker": self.server.marker.decode(), "path": self.path,
                               "headers": dict(self.headers)}).encode()
        elif path == "/browser":
            body = b"<!doctype html><script src='/asset.js'></script><h1>" + self.server.marker + b"</h1>"
        elif path == "/asset.js":
            body = ("window.fixtureAsset = " + json.dumps(self.server.marker.decode()) + ";").encode()
        self.send_response(200)
        if path in ("/browser", "/asset.js"):
            self.send_header("Content-Type", "text/html" if path == "/browser" else "application/javascript")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "keep-alive" if path == "/keepalive" else "close")
        if path == "/inspect":
            self.send_header("Set-Cookie", "app-cookie=kept; Path=/")
            self.send_header("Set-Cookie", "__Host-boxlite-tunnel-session=guest-forged; Secure; Path=/")
        self.end_headers()
        if self.path == "/slow":
            for offset in range(0, len(body), 8192):
                self.wfile.write(body[offset : offset + 8192])
                self.wfile.flush()
                time.sleep(0.002)
        else:
            self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        response = MARKER + b":" + hashlib.sha256(body).hexdigest().encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(response)

    def _websocket_echo(self):
        key = self.headers["Sec-WebSocket-Key"]
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        while True:
            frame = self.rfile.read(2)
            if len(frame) != 2 or frame[0] & 0x0F == 8:
                return
            first, second = frame
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self.rfile.read(2))[0]
            mask = self.rfile.read(4)
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(self.rfile.read(length)))
            response = self.server.marker + b":" + payload
            header = bytes([first & 0x8F, len(response)])
            self.wfile.write(header + response)
            self.wfile.flush()

    def log_message(self, _format, *_args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if len(sys.argv) > 3:
    second = Server(("0.0.0.0", int(sys.argv[3])), Handler)
    second.marker = MARKER + b"-second"
    threading.Thread(target=second.serve_forever, daemon=True).start()
server = Server(("0.0.0.0", PORT), Handler)
server.marker = MARKER
server.serve_forever()
