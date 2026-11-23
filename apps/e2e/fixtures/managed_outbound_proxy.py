"""Record CONNECT on an isolated acceptance listener with fixed test destinations."""
from argparse import ArgumentParser
import asyncio
import base64
from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
from ipaddress import IPv4Address
import json
import os
from pathlib import Path
import ssl
import time


VARIANTS = tuple(f"{scheme}-{auth}" for scheme in ("http", "https", "socks5")
                 for auth in ("anonymous", "credential"))
HTTP_OK = b"HTTP/1.1 200 Connection Established\r\n\r\n"
HTTP_AUTH_REQUIRED = b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="acceptance"\r\nContent-Length: 0\r\n\r\n'
MALFORMED_CONNECT_REPLY = b"fixture invalid CONNECT response\r\n\r\n"
SOCKS_OK = b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00"
TUNNEL_IDLE_SECONDS = 300


def destination(authority):
    address, separator, port = authority.rpartition(":")
    if not separator or not port.isascii() or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("expected IPv4:port")
    return str(IPv4Address(address)), int(port)


def proxy_tls(cert, key, *, tls_observations=None):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    fingerprint = None
    if tls_observations is not None:
        pem = Path(cert).read_text().split("-----END CERTIFICATE-----", 1)[0].strip()
        fingerprint = sha256(ssl.PEM_cert_to_DER_cert(f"{pem}\n-----END CERTIFICATE-----")).hexdigest()

    def remember_sni(connection, name, _context):
        connection.probe_sni = name
        if tls_observations is not None:
            event = {"event": "tls_selection", "sni": name, "certificate_sha256": fingerprint, "time_ns": time.time_ns()}
            os.write(tls_observations, (json.dumps(event) + "\n").encode())

    context.set_servername_callback(remember_sni)
    return context


async def http_connect(reader, credential):
    request, *headers = (await reader.readuntil(b"\r\n\r\n"))[:-4].split(b"\r\n")
    method, authority, version = request.split(b" ")
    if method != b"CONNECT" or version != b"HTTP/1.1":
        raise ValueError("expected HTTP/1.1 CONNECT")
    auth = [value.strip() for line in headers for name, _, value in [line.partition(b":")]
            if name.strip().lower() == b"proxy-authorization"]
    if credential is None:
        accepted = not auth
        mode = "none"
    else:
        expected = b"Basic " + base64.b64encode(b":".join(credential))
        accepted = len(auth) == 1 and compare_digest(auth[0], expected)
        mode = "basic"
    evidence = {"method": "CONNECT", "auth": mode, "basic_header_present": len(auth) == 1 and auth[0].startswith(b"Basic ")}
    return destination(authority.decode("ascii")), evidence, accepted


async def socks_connect(reader, writer, credential):
    version, count = await reader.readexactly(2)
    offered = list(await reader.readexactly(count))
    method = 0 if credential is None else 2
    if version != 5 or method not in offered:
        writer.write(b"\x05\xff")
        await writer.drain()
        raise PermissionError("SOCKS5 authentication method refused")
    writer.write(bytes([5, method]))
    await writer.drain()
    if credential is not None:
        auth_version, size = await reader.readexactly(2)
        username = await reader.readexactly(size)
        password = await reader.readexactly((await reader.readexactly(1))[0])
        accepted = auth_version == 1 and compare_digest(username, credential[0]) and compare_digest(password, credential[1])
        writer.write(bytes([1, 0 if accepted else 1]))
        await writer.drain()
        if not accepted:
            raise PermissionError("SOCKS5 credential refused")
    if await reader.readexactly(4) != b"\x05\x01\x00\x01":
        raise ValueError("expected SOCKS5 CONNECT to a numeric IPv4 target")
    address = str(IPv4Address(await reader.readexactly(4)))
    port = int.from_bytes(await reader.readexactly(2), "big")
    return (address, port), {"method": "CONNECT", "auth": "none" if method == 0 else "rfc1929",
                             "offered_methods": offered, "selected_method": method}


async def relay(reader, writer):
    while data := await asyncio.wait_for(reader.read(65536), timeout=TUNNEL_IDLE_SECONDS):
        writer.write(data)
        await writer.drain()


@dataclass(frozen=True)
class AcceptanceProxy:
    variant: str
    clients: frozenset[str]
    destinations: frozenset[tuple[str, int]]
    observations: int
    credential: tuple[bytes, bytes] | None = field(repr=False)
    fault: str | None = None
    fault_destination: tuple[str, int] | None = None

    async def attempt_socks_downgrade(self, reader, writer):
        version, count = await reader.readexactly(2)
        offered = list(await reader.readexactly(count))
        if version != 5:
            return
        writer.write(b"\x05\x00")
        await writer.drain()
        following = await reader.read(4)
        event = {"event": "socks_downgrade", "offered_methods": offered, "selected_method": 0,
                 "client_closed": not following, "time_ns": time.time_ns()}
        os.write(self.observations, (json.dumps(event) + "\n").encode())

    def record(self, target, transport, outcome, negotiation, authenticated):
        event = {
            **negotiation,
            "listener": self.variant,
            "scheme": self.variant.split("-")[0],
            "destination_ip": target[0],
            "destination_port": target[1],
            "authenticated": authenticated,
            "sni": getattr(transport, "probe_sni", None),
            "time_ns": time.time_ns(),
            "outcome": outcome,
        }
        os.write(self.observations, (json.dumps(event) + "\n").encode())

    async def handle(self, reader, writer):
        upstream = None
        try:
            if writer.get_extra_info("peername")[0] not in self.clients:
                return
            transport = writer.get_extra_info("ssl_object")
            scheme, _ = self.variant.split("-")
            if (transport is not None) != (scheme == "https"):
                return

            async with asyncio.timeout(10):
                accepted = True
                if scheme == "socks5":
                    if self.fault == "socks-downgrade":
                        await self.attempt_socks_downgrade(reader, writer)
                        return
                    target, evidence = await socks_connect(reader, writer, self.credential)
                else:
                    target, evidence, accepted = await http_connect(reader, self.credential)
            if target not in self.destinations:
                return
            if not accepted:
                self.record(target, transport, "auth_rejected", evidence, False)
                writer.write(HTTP_AUTH_REQUIRED)
                await writer.drain()
                return
            authenticated = self.credential is not None
            if target == self.fault_destination:
                if self.fault == "stall":
                    self.record(target, transport, "negotiation_stalled", evidence, authenticated)
                    # The client must exhaust its own setup deadline.
                    await asyncio.wait_for(reader.read(1), timeout=35)
                    return
                if self.fault == "malformed":
                    self.record(target, transport, "malformed_reply", evidence, authenticated)
                    writer.write(MALFORMED_CONNECT_REPLY)
                    await writer.drain()
                    return

            async with asyncio.timeout(10):
                target_reader, upstream = await asyncio.open_connection(*target)
                self.record(target, transport, "connected", evidence, authenticated)
                writer.write(SOCKS_OK if scheme == "socks5" else HTTP_OK)
                await writer.drain()

            transfers = [asyncio.create_task(relay(reader, upstream)), asyncio.create_task(relay(target_reader, writer))]
            try:
                await asyncio.wait(transfers, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for transfer in transfers:
                    transfer.cancel()
                await asyncio.gather(*transfers, return_exceptions=True)
        except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            pass
        finally:
            if upstream is not None:
                upstream.close()
            writer.close()


async def serve(args):
    credential = None
    if args.credential is not None:
        path = Path(args.credential)
        if path.stat().st_mode & 0o077:
            raise ValueError("proxy credential file must be private")
        with path.open("rb") as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError("invalid proxy credential file")
        secret = json.loads(raw)
        credential = (secret["username"].encode("ascii"), secret["password"].encode("ascii"))
        if not all(0 < len(value) <= 255 for value in credential):
            raise ValueError("invalid proxy credential length")

    descriptor = os.open(args.observations, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
    try:
        context = proxy_tls(args.cert, args.key, tls_observations=descriptor if args.observe_tls else None) if args.cert else None
        fixture = AcceptanceProxy(args.variant, frozenset(args.client), frozenset(args.destination), descriptor, credential,
                                  args.fault, args.fault_destination)
        server = await asyncio.start_server(fixture.handle, args.bind, args.port, ssl=context, limit=16384)
        async with server:
            await server.serve_forever()
    finally:
        os.close(descriptor)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=VARIANTS, required=True)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--client", action="append", type=lambda address: str(IPv4Address(address)), required=True)
    parser.add_argument("--destination", action="append", type=destination, required=True)
    parser.add_argument("--observations", required=True)
    parser.add_argument("--credential")
    parser.add_argument("--cert")
    parser.add_argument("--key")
    parser.add_argument("--fault", choices=("stall", "malformed", "socks-downgrade"))
    parser.add_argument("--fault-destination", type=destination)
    parser.add_argument("--observe-tls", action="store_true")
    args = parser.parse_args()
    scheme, auth = args.variant.split("-")
    if scheme == "https" and not (args.cert and args.key) or scheme != "https" and (args.cert or args.key):
        parser.error("supply a certificate and key for HTTPS only")
    if (auth == "credential") != bool(args.credential):
        parser.error("supply a private credential file for credential variants only")
    if args.observe_tls and scheme != "https":
        parser.error("TLS selection observations require an HTTPS listener")
    if args.fault == "socks-downgrade":
        if args.variant != "socks5-credential" or args.fault_destination is not None:
            parser.error("SOCKS downgrade requires a credential listener before any destination is sent")
    elif bool(args.fault) != bool(args.fault_destination):
        parser.error("supply both fault mode and destination")
    elif args.fault and (scheme == "socks5" or args.fault_destination not in args.destination):
        parser.error("a CONNECT fault requires an allowed HTTP or HTTPS destination")
    asyncio.run(serve(args))


if __name__ == "__main__":
    main()
