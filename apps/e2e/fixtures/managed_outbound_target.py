"""Owned HTTPS and UDP target for observing managed outbound probes."""
from argparse import ArgumentParser
from contextlib import contextmanager
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
from socketserver import BaseRequestHandler, UDPServer
import ssl
from threading import Thread
import time
from uuid import uuid4


KEEP_ALIVE_IDLE_SECONDS = 300


class ProbeServer(ThreadingHTTPServer):
    daemon_threads = False

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


class ProbeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection_id = uuid4().hex

    def log_message(self, *_args):
        pass

    def do_GET(self):
        match = re.fullmatch(r"/probe/([0-9a-f]{32})", self.path)
        if match is None:
            self.send_error(404)
            return
        marker = match[1]
        keep_alive = self.headers.get("Connection", "").lower() == "keep-alive"
        observation = {
            "protocol": "https",
            "marker": marker,
            "source": str(ipaddress.ip_address(self.client_address[0])),
            "host": self.headers.get("Host"),
            "sni": getattr(self.connection, "probe_sni", None),
            "connection_id": self.connection_id,
            "time_ns": time.time_ns(),
        }
        if self.server.expected_authorization is not None:
            headers = self.headers.get_all("Authorization", [])
            observation["secret_matches"] = len(headers) == 1 and compare_digest(
                headers[0].encode("latin-1"), self.server.expected_authorization,
            )
        os.write(self.server.observations, (json.dumps(observation) + "\n").encode())
        data = marker.encode("ascii")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        if keep_alive:
            self.connection.settimeout(KEEP_ALIVE_IDLE_SECONDS)
        else:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)


class DatagramServer(UDPServer):
    def __init__(self, address, observations, release_dir):
        super().__init__(address, DatagramHandler)
        self.observations = observations
        self.release_dir = release_dir
        self.held = {}

    def record(self, event, marker, peer):
        row = {"protocol": event, "marker": marker, "source": str(ipaddress.ip_address(peer[0])),
               "source_port": peer[1], "time_ns": time.time_ns()}
        os.write(self.observations, (json.dumps(row) + "\n").encode())

    def service_actions(self):
        for marker, (late, peer, expires) in list(self.held.items()):
            if time.monotonic() >= expires:
                del self.held[marker]
                continue
            if (self.release_dir / marker).is_file():
                del self.held[marker]
                self.socket.sendto(late.encode("ascii"), peer)
                self.record("udp-delayed-reply", late, peer)


class DatagramHandler(BaseRequestHandler):
    def handle(self):
        payload, socket = self.request
        if re.fullmatch(rb"[0-9a-f]{32}", payload):
            self.server.record("udp", payload.decode("ascii"), self.client_address)
            socket.sendto(payload, self.client_address)
        elif self.server.release_dir is not None:
            request = re.fullmatch(rb"hold:([0-9a-f]{32}):([0-9a-f]{32})", payload)
            if request is None:
                return
            marker, late = (part.decode("ascii") for part in request.groups())
            if marker == late or marker in self.server.held or len(self.server.held) >= 64:
                return
            if (self.server.release_dir / marker).exists():
                return
            self.server.held[marker] = (late, self.client_address, time.monotonic() + 180)
            self.server.record("udp-held", marker, self.client_address)
            socket.sendto(request[1], self.client_address)


def remember_sni(connection, name, _context):
    connection.probe_sni = name


@contextmanager
def target_server(bind, port, cert, key, observations, *, workload_secret=None):
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(cert, key)
    tls.set_servername_callback(remember_sni)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND
    descriptor = os.open(observations, flags, 0o600)
    try:
        with ProbeServer((bind, port), ProbeHandler) as server:
            server.observations = descriptor
            server.expected_authorization = (
                f"Bearer {workload_secret}".encode("ascii") if workload_secret is not None else None
            )
            server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
            yield server
    finally:
        os.close(descriptor)


@contextmanager
def datagram_listener(bind, port, observations, *, release_dir=None):
    with DatagramServer((bind, port), observations, release_dir) as server:
        worker = Thread(target=server.serve_forever)
        worker.start()
        try:
            yield server.server_address[1]
        finally:
            server.shutdown()
            worker.join()


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--udp-port", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--observations", required=True)
    parser.add_argument("--workload-secret-file", type=Path)
    parser.add_argument("--udp-release-dir", type=Path)
    args = parser.parse_args()
    if args.udp_release_dir is not None and not args.udp_release_dir.is_dir():
        parser.error("--udp-release-dir must be an existing fixture directory")
    secret = None
    if args.workload_secret_file is not None:
        path = args.workload_secret_file
        if not path.is_file() or path.stat().st_mode & 0o077:
            parser.error("use a private workload secret file")
        with path.open("rb") as stream:
            value = stream.read(258)
        if re.fullmatch(rb"[A-Za-z0-9._~-]{16,256}\n?", value) is None:
            parser.error("use a synthetic workload token with 16 to 256 URL-safe characters")
        secret = value.rstrip(b"\n").decode("ascii")
    with target_server(args.bind, args.port, args.cert, args.key, args.observations,
                       workload_secret=secret) as server:
        with datagram_listener(args.bind, args.udp_port, server.observations, release_dir=args.udp_release_dir):
            server.serve_forever()


if __name__ == "__main__":
    main()
