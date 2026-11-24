"""Controlled DoH and direct DNS observers for an isolated acceptance zone."""
from argparse import ArgumentParser
from contextlib import contextmanager
from dataclasses import dataclass
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address, IPv6Address
import json
import os
import re
import socket
from socketserver import BaseRequestHandler, ThreadingTCPServer, ThreadingUDPServer
import ssl
import struct
from threading import Thread
import time


DNS_MESSAGE = "application/dns-message"
RECORD_TYPES = {"A": 1, "AAAA": 28}
RECORD_NAMES = {value: name for name, value in RECORD_TYPES.items()}
UDP_REFUSAL = {errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES, errno.EPERM}
QUESTION_LABEL = re.compile(r"(answer|wrong-id|stall)-[0-9a-f]{32}")
DOMAIN_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


def domain(value):
    name = value.rstrip(".").lower()
    if len(name) > 253 or not all(DOMAIN_LABEL.fullmatch(label) for label in name.split(".")):
        raise ValueError("invalid DNS fixture name")
    return name


def name_wire(name):
    return b"".join(bytes([len(label)]) + label.encode("ascii") for label in domain(name).split(".")) + b"\0"


@dataclass(frozen=True)
class Question:
    name: str
    record_type: int
    end: int


def question(wire):
    _, flags, count, _, _, _ = struct.unpack_from("!6H", wire)
    if count != 1 or flags & 0x7800:
        raise ValueError("expected one standard DNS question")
    labels = []
    offset = 12
    while (size := wire[offset]):
        if size > 63 or offset + size + 1 >= len(wire):
            raise ValueError("invalid DNS question label")
        labels.append(wire[offset + 1:offset + size + 1].decode("ascii"))
        offset += size + 1
    record_type, record_class = struct.unpack_from("!HH", wire, offset + 1)
    if record_class != 1:
        raise ValueError("expected an IN question")
    return Question(domain(".".join(labels)), record_type, offset + 5)


def reply(wire, query, address, *, wrong_id=False):
    identifier, flags = struct.unpack_from("!HH", wire)
    header = struct.pack("!6H", identifier ^ int(wrong_id), 0x8080 | (flags & 0x0100), 1, int(bool(address)), 0, 0)
    record = b"" if address is None else b"\xc0\x0c" + struct.pack("!HHIH", query.record_type, 1, 0, len(address)) + address
    return header + wire[12:query.end] + record


def read_exact(stream, length):
    result = stream.read(length)
    if len(result) != length:
        raise EOFError("truncated DNS frame")
    return result


def read_frame(stream):
    length, = struct.unpack("!H", read_exact(stream, 2))
    if not 12 <= length <= 4096:
        raise ValueError("invalid DNS frame length")
    return read_exact(stream, length)


def query_gateway(mode, address, port, name, kind):
    identifier, = struct.unpack("!H", os.urandom(2))
    wire = struct.pack("!6H", identifier, 0x0100, 1, 0, 0, 0) + name_wire(name) + struct.pack("!HH", RECORD_TYPES[kind], 1)
    transport = socket.SOCK_DGRAM if mode == "udp" else socket.SOCK_STREAM
    deadline = time.monotonic()
    with socket.socket(socket.AF_INET, transport) as client:
        client.settimeout(8)
        client.connect((address, port))
        if mode == "udp":
            client.sendall(wire)
            response = client.recv(4097)
        else:
            client.sendall(struct.pack("!H", len(wire)) + wire)
            with client.makefile("rb") as stream:
                response = read_frame(stream)
    elapsed = time.monotonic() - deadline
    response_id, flags, _, answers, _, _ = struct.unpack_from("!6H", response)
    query = question(response)
    if response_id != identifier or flags & 0x8200 != 0x8000 or query != question(wire) or answers > 1:
        raise ValueError("unexpected DNS response identity or answer count")
    values = []
    if answers:
        owner = b"\xc0\x0c" if response[query.end:query.end + 2] == b"\xc0\x0c" else name_wire(query.name)
        position = query.end + len(owner)
        if response[query.end:position] != owner:
            raise ValueError("DNS answer owner differs from its question")
        record_type, record_class, _, size = struct.unpack_from("!HHIH", response, position)
        if record_type != query.record_type or record_class != 1:
            raise ValueError("unexpected DNS answer type")
        value = response[position + 10:position + 10 + size]
        if len(value) != size:
            raise ValueError("truncated DNS answer")
        values.append(str((IPv4Address if kind == "A" else IPv6Address)(value)))
    return {"rcode": flags & 15, "answers": values, "elapsed": elapsed}


@dataclass(frozen=True)
class DNSObserver:
    zone: str
    a: bytes
    aaaa: bytes
    observations: int
    clients: frozenset[str]
    bootstrap: dict[str, bytes]
    private_a: bytes | None = None

    def observe(self, wire, source, transport, **tls):
        if source not in self.clients or len(wire) > 4096:
            return None
        try:
            if wire[2] & 0x80:
                return None
            query = question(wire)
        except (IndexError, struct.error, ValueError):
            return None
        label, _, zone = query.name.partition(".")
        controlled = QUESTION_LABEL.fullmatch(label) if zone == self.zone else None
        if controlled:
            outcome = controlled[1] if transport == "doh" else "answer"
            address = {1: self.a, 28: self.aaaa}.get(query.record_type)
        elif zone == self.zone and self.private_a is not None and re.fullmatch(r"private-[0-9a-f]{32}", label):
            outcome, address = "answer", self.private_a if query.record_type == 1 else None
        elif transport != "doh" and query.name in self.bootstrap:
            outcome, address = "answer", self.bootstrap[query.name] if query.record_type == 1 else None
        else:
            return None
        row = {"name": query.name, "source": source, "transport": transport, "outcome": outcome,
               "type": RECORD_NAMES.get(query.record_type, f"TYPE{query.record_type}"), "time_ns": time.time_ns(), **tls}
        if address is not None:
            row["address"] = str((IPv4Address if query.record_type == 1 else IPv6Address)(address))
        os.write(self.observations, (json.dumps(row) + "\n").encode())
        if outcome == "stall":
            time.sleep(8)
        return reply(wire, query, address, wrong_id=outcome == "wrong-id")


class DoHHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(10)
        length = self.headers.get("Content-Length", "")
        if (self.path != "/dns-query" or self.headers.get("Content-Type") != DNS_MESSAGE
                or not re.fullmatch(r"[0-9]{1,4}", length) or not 12 <= int(length) <= 4096):
            self.send_error(400)
            return
        try:
            response = self.server.observer.observe(read_exact(self.rfile, int(length)), self.client_address[0], "doh",
                                                    host=self.headers.get("Host"),
                                                    sni=getattr(self.connection, "probe_sni", None))
            if response is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", DNS_MESSAGE)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        except (EOFError, OSError):
            return


class DirectUDPHandler(BaseRequestHandler):
    def handle(self):
        wire, sender = self.request
        response = self.server.observer.observe(wire, self.client_address[0], "udp")
        if response:
            sender.sendto(response, self.client_address)


class DirectTCPHandler(BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            with self.request.makefile("rb") as stream:
                while True:
                    response = self.server.observer.observe(read_frame(stream), self.client_address[0], "tcp")
                    if not response:
                        return
                    self.request.sendall(struct.pack("!H", len(response)) + response)
        except (EOFError, OSError, ValueError):
            return


@contextmanager
def doh_server(bind, port, cert, key, observer):
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(cert, key)
    tls.set_servername_callback(lambda connection, name, _: setattr(connection, "probe_sni", name))
    with ThreadingHTTPServer((bind, port), DoHHandler) as server:
        server.observer = observer
        server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        yield server


@contextmanager
def direct_dns_servers(bind, port, observer):
    with ThreadingTCPServer((bind, port), DirectTCPHandler) as tcp:
        with ThreadingUDPServer((bind, tcp.server_address[1]), DirectUDPHandler) as udp:
            tcp.observer = udp.observer = observer
            yield tcp, udp


def main():
    parser = ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    probe = modes.add_parser("probe")
    probe.add_argument("transport", choices=("tcp", "udp"))
    probe.add_argument("address", type=IPv4Address)
    probe.add_argument("port", type=int)
    probe.add_argument("name", type=domain)
    probe.add_argument("kind", choices=RECORD_TYPES)
    probe.add_argument("--accept-blocked", action="store_true")
    for name in ("doh", "direct"):
        server = modes.add_parser(name)
        server.add_argument("--bind", type=IPv4Address, required=True)
        server.add_argument("--port", type=int, required=True)
        server.add_argument("--zone", type=domain, required=True)
        server.add_argument("--a", type=IPv4Address, required=True)
        server.add_argument("--aaaa", type=IPv6Address, required=True)
        server.add_argument("--private-a", type=IPv4Address)
        server.add_argument("--client", type=IPv4Address, action="append", required=True)
        server.add_argument("--observations", required=True)
        if name == "doh":
            server.add_argument("--cert", required=True)
            server.add_argument("--key", required=True)
        else:
            server.add_argument("--bootstrap", nargs=2, metavar=("NAME", "IPV4"), action="append", default=[])
    args = parser.parse_args()
    if args.mode == "probe":
        if args.accept_blocked and args.transport != "udp":
            parser.error("--accept-blocked is for a direct UDP probe")
        try:
            observed = query_gateway(args.transport, str(args.address), args.port, args.name, args.kind)
        except OSError as exc:
            if not args.accept_blocked or not (isinstance(exc, TimeoutError) or exc.errno in UDP_REFUSAL):
                raise
            observed = {"blocked": True}
        print(json.dumps(observed))
        return
    bootstrap = {domain(name): IPv4Address(value).packed for name, value in getattr(args, "bootstrap", [])}
    descriptor = os.open(args.observations, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
    observer = DNSObserver(args.zone, args.a.packed, args.aaaa.packed, descriptor,
                           frozenset(map(str, args.client)), bootstrap, args.private_a.packed if args.private_a else None)
    try:
        if args.mode == "doh":
            with doh_server(str(args.bind), args.port, args.cert, args.key, observer) as server:
                server.serve_forever()
        else:
            with direct_dns_servers(str(args.bind), args.port, observer) as (tcp, udp):
                worker = Thread(target=udp.serve_forever)
                worker.start()
                try:
                    tcp.serve_forever()
                finally:
                    udp.shutdown()
                    worker.join()
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    main()
