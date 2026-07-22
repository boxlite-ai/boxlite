import base64
import hashlib
import socketserver
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler


PORT = int(sys.argv[1])
MARKER = sys.argv[2].encode()
LARGE_BODY = MARKER + b":" + (b"x" * (2 * 1024 * 1024))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/ws":
            self._websocket_echo()
            return
        body = LARGE_BODY if self.path in ("/large", "/slow") else MARKER
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
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
        first, second = self.rfile.read(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self.rfile.read(2))[0]
        mask = self.rfile.read(4)
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(self.rfile.read(length)))
        response = MARKER + b":" + payload
        header = bytes([first & 0x8F, len(response)])
        self.wfile.write(header + response)
        self.wfile.flush()

    def log_message(self, _format, *_args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


Server(("0.0.0.0", PORT), Handler).serve_forever()
