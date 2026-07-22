from __future__ import annotations

import asyncio
import hashlib
import os
import shlex
import struct

import pytest

import boxlite


pytestmark = [pytest.mark.integration, pytest.mark.asyncio]

LOCAL_IMAGE = "python:3-alpine"
LOCAL_PORT = 18081
CLOUD_MARKER = b"boxlite-dev-tunnel-e2e"
LOCAL_MARKER = b"boxlite-local-tunnel-e2e"
BINARY_PORT = 18082
BINARY_PAYLOAD_SIZE = 4 * 1024 * 1024
BINARY_CONNECTIONS = 4


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        pytest.skip(f"{name} is required for the dev tunnel E2E test")
    return value


async def _http_get(tunnel, host: str, marker: bytes) -> bytes:
    connection = await tunnel.connect()
    request = (f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").encode()

    try:
        await asyncio.wait_for(connection.write(request), timeout=10)
        response = bytearray()
        while True:
            chunk = await asyncio.wait_for(
                connection.read(64 * 1024),
                timeout=10,
            )
            if not chunk:
                break
            response.extend(chunk)
            if marker in response:
                break
        return bytes(response)
    finally:
        await connection.close()


async def _wait_for_http_server(
    box, port: int, tunnel, host: str, marker: bytes
) -> bytes:
    deadline = asyncio.get_running_loop().time() + 20
    last_result = "no connection attempt completed"
    while True:
        try:
            response = await _http_get(tunnel, host, marker)
            if response.startswith(b"HTTP/1."):
                return response
            last_result = f"unexpected response: {response[:200]!r}"
        except (ConnectionError, OSError, RuntimeError, TimeoutError) as error:
            last_result = f"{type(error).__name__}: {error}"
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(
                f"HTTP server in box did not become ready; last result: {last_result}"
            )
        await asyncio.sleep(0.5)
        tunnel = await box.network.tunnel(port)


def _host_for_endpoint(endpoint: str | int) -> str:
    if isinstance(endpoint, str) and endpoint.startswith(("http://", "https://")):
        return endpoint.split("://", 1)[1].split("/", 1)[0]
    return "localhost"


async def _serve_marker_http(box, port: int, marker: bytes):
    code = (
        "from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer;"
        "H=type('H',(BaseHTTPRequestHandler,),{"
        "'do_GET':lambda s:(s.send_response(200),s.end_headers(),"
        f"s.wfile.write({marker!r}))}});"
        f"ThreadingHTTPServer(('0.0.0.0',{port}),H).serve_forever()"
    )
    if isinstance(box, boxlite.SimpleBox):
        command = (
            f"python3 -u -c {shlex.quote(code)} >/tmp/tunnel-e2e.log 2>&1 & echo $!"
        )
        result = await box.exec("sh", "-c", command)
        pid = result.stdout.strip()

        class LocalServer:
            async def kill(self):
                await box.exec("kill", pid)

        return LocalServer()
    return await box.exec("python3", ["-u", "-c", code])


async def _serve_binary_echo(box, port: int):
    code = """
import hashlib
import socketserver
import struct

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        header = self._read_exact(8)
        if header is None:
            return
        remaining = struct.unpack("!Q", header)[0]
        digest = hashlib.sha256()
        total = 0
        while remaining:
            chunk = self.request.recv(min(65536, remaining))
            if not chunk:
                return
            digest.update(chunk)
            total += len(chunk)
            remaining -= len(chunk)
            self.request.sendall(chunk)
        trailer = b"BOXLITE-DIGEST " + str(total).encode() + b" " + digest.hexdigest().encode() + b"\\n"
        self.request.sendall(trailer)

    def _read_exact(self, size):
        result = bytearray()
        while len(result) < size:
            chunk = self.request.recv(size - len(result))
            if not chunk:
                return None
            result.extend(chunk)
        return bytes(result)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

Server(("0.0.0.0", PORT), Handler).serve_forever()
""".replace("PORT", str(port))
    if isinstance(box, boxlite.SimpleBox):
        command = f"python3 -u -c {shlex.quote(code)} >/tmp/tunnel-binary-e2e.log 2>&1 & echo $!"
        result = await box.exec("sh", "-c", command)
        pid = result.stdout.strip()

        class LocalServer:
            async def kill(self):
                await box.exec("kill", pid)

        return LocalServer()
    return await box.exec("python3", ["-u", "-c", code])


def _binary_payload(connection_index: int) -> bytes:
    seed = bytes(range(256)) + b"\x00\xffboxlite-tunnel\x00"
    payload = (seed * (BINARY_PAYLOAD_SIZE // len(seed) + 1))[:BINARY_PAYLOAD_SIZE]
    return bytes([connection_index]) + payload[1:]


async def _binary_round_trip(box, port: int, connection_index: int) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 20
    while True:
        tunnel = await box.network.tunnel(port)
        try:
            connection = await tunnel.connect()
            break
        except (ConnectionError, OSError, RuntimeError):
            if loop.time() >= deadline:
                raise
            await asyncio.sleep(0.25)
    payload = _binary_payload(connection_index)
    digest = hashlib.sha256(payload).hexdigest().encode()
    trailer = b"BOXLITE-DIGEST " + str(len(payload)).encode() + b" " + digest + b"\n"
    chunk_sizes = (1, 7, 31, 257, 4093, 16384, 65521)

    async def send() -> None:
        await connection.write(struct.pack("!Q", len(payload)))
        offset = 0
        chunk_index = 0
        while offset < len(payload):
            size = chunk_sizes[chunk_index % len(chunk_sizes)]
            await connection.write(payload[offset : offset + size])
            offset += size
            chunk_index += 1

    async def receive() -> bytes:
        response = bytearray()
        expected_size = len(payload) + len(trailer)
        while len(response) < expected_size:
            chunk = await connection.read(64 * 1024)
            if not chunk:
                break
            response.extend(chunk)
        return bytes(response)

    try:
        _, response = await asyncio.wait_for(
            asyncio.gather(send(), receive()), timeout=60
        )
        assert response == payload + trailer
    finally:
        await connection.close()


async def _wait_for_binary_server(box, port: int) -> None:
    loop = asyncio.get_running_loop()
    expected = b"BOXLITE-DIGEST 0 " + hashlib.sha256(b"").hexdigest().encode() + b"\n"
    deadline = loop.time() + 20
    last_error = "no connection attempt completed"
    while loop.time() < deadline:
        tunnel = await box.network.tunnel(port)
        connection = None
        try:
            connection = await tunnel.connect()
            await connection.write(struct.pack("!Q", 0))
            response = bytearray()
            while len(response) < len(expected):
                chunk = await asyncio.wait_for(connection.read(4096), timeout=2)
                if not chunk:
                    break
                response.extend(chunk)
            if bytes(response) == expected:
                return
            last_error = f"unexpected readiness response: {bytes(response)!r}"
        except (ConnectionError, OSError, RuntimeError, TimeoutError) as error:
            last_error = f"{type(error).__name__}: {error}"
        finally:
            if connection is not None:
                await connection.close()
        await asyncio.sleep(0.25)
    raise AssertionError(
        f"binary tunnel server did not become ready; last result: {last_error}"
    )


async def _assert_binary_tunnel(box, port: int) -> None:
    server = await _serve_binary_echo(box, port)
    try:
        await _wait_for_binary_server(box, port)
        await asyncio.gather(
            *(
                _binary_round_trip(box, port, index)
                for index in range(BINARY_CONNECTIONS)
            )
        )
    finally:
        await server.kill()


async def _assert_tunnel_endpoint_and_one_shot_connects(
    box,
    port: int,
    marker: bytes,
    assert_endpoint,
):
    server = await _serve_marker_http(box, port, marker)

    try:
        first_tunnel = await box.network.tunnel(port)
        endpoint = first_tunnel.endpoint()
        assert_endpoint(endpoint)

        host = _host_for_endpoint(endpoint)
        first = await _wait_for_http_server(box, port, first_tunnel, host, marker)
        second_tunnel = await box.network.tunnel(port)
        second = await _http_get(second_tunnel, host, marker)

        assert marker in first, first[:200]
        assert marker in second, second[:200]
    finally:
        await server.kill()


def _assert_local_endpoint(endpoint: int) -> None:
    assert isinstance(endpoint, int)
    assert endpoint >= 0


def _assert_cloud_endpoint(port: int):
    def check(endpoint: str) -> None:
        assert endpoint.startswith(("http://", "https://"))
        assert str(port) in endpoint

    return check


@pytest.mark.integration
async def test_local_box_tunnel_endpoint_and_one_shot_connects(shared_runtime):
    async with boxlite.SimpleBox(
        image=LOCAL_IMAGE,
        runtime=shared_runtime,
        memory_mib=512,
        cpus=1,
    ) as box:
        await _assert_tunnel_endpoint_and_one_shot_connects(
            box,
            LOCAL_PORT,
            LOCAL_MARKER,
            _assert_local_endpoint,
        )


@pytest.mark.integration
async def test_local_box_tunnel_binary_integrity(shared_runtime):
    async with boxlite.SimpleBox(
        image=LOCAL_IMAGE,
        runtime=shared_runtime,
        memory_mib=512,
        cpus=1,
    ) as box:
        await _assert_binary_tunnel(box, BINARY_PORT)


@pytest.mark.e2e
async def test_dev_cloud_tunnel_endpoint_and_one_shot_connects():
    from boxlite import ApiKeyCredential, Boxlite, BoxliteRestOptions

    api_key = _required_env("BOXLITE_API_KEY")
    box_id = _required_env("BOXLITE_E2E_BOX_ID")
    rest_url = os.getenv("BOXLITE_REST_URL", "https://dev.boxlite.ai/api")
    path_prefix = os.getenv("BOXLITE_REST_PATH_PREFIX")
    port = int(os.getenv("BOXLITE_E2E_PORT", "18080"))

    runtime = Boxlite.rest(
        BoxliteRestOptions(
            url=rest_url,
            credential=ApiKeyCredential(api_key),
            path_prefix=path_prefix,
        )
    )
    box = await runtime.get(box_id)
    assert box is not None, f"dev box {box_id!r} was not found"

    await _assert_tunnel_endpoint_and_one_shot_connects(
        box,
        port,
        CLOUD_MARKER,
        _assert_cloud_endpoint(port),
    )


@pytest.mark.e2e
async def test_dev_cloud_tunnel_binary_integrity():
    from boxlite import ApiKeyCredential, Boxlite, BoxliteRestOptions

    api_key = _required_env("BOXLITE_API_KEY")
    box_id = _required_env("BOXLITE_E2E_BOX_ID")
    rest_url = os.getenv("BOXLITE_REST_URL", "https://dev.boxlite.ai/api")
    path_prefix = os.getenv("BOXLITE_REST_PATH_PREFIX")
    port = int(os.getenv("BOXLITE_E2E_BINARY_PORT", str(BINARY_PORT)))
    runtime = Boxlite.rest(
        BoxliteRestOptions(
            url=rest_url,
            credential=ApiKeyCredential(api_key),
            path_prefix=path_prefix,
        )
    )
    box = await runtime.get(box_id)
    assert box is not None, f"dev box {box_id!r} was not found"
    await _assert_binary_tunnel(box, port)
