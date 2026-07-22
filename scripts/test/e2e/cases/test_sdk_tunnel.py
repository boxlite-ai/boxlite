"""REST E2E coverage for the Python SDK's public network handle."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from pathlib import Path
import shlex

import boxlite
import pytest


SERVICES = ((18080, b"python-sdk-tunnel-e2e-a"), (18082, b"python-sdk-tunnel-e2e-b"))
FIXTURE = Path(__file__).parents[1] / "fixtures" / "service_in_box_server.py"


async def _get_over_tunnel(box: boxlite.SimpleBox, port: int, marker: bytes) -> bytes:
    tunnel = await box.network.tunnel(port)
    connection = await tunnel.connect()
    response = bytearray()
    try:
        await connection.write(
            b"GET /marker.txt HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        while len(response) < 64 * 1024:
            chunk = await asyncio.wait_for(connection.read(8192), timeout=5)
            if not chunk:
                break
            response.extend(chunk)
            if marker in response:
                break
        return bytes(response)
    finally:
        await connection.close()


async def _start_service(box, port: int, marker: bytes) -> str:
    encoded = base64.b64encode(FIXTURE.read_bytes()).decode()
    code = f"import base64;exec(base64.b64decode({encoded!r}))"
    result = await box.exec(
        "sh",
        "-lc",
        f"python3 -u -c {shlex.quote(code)} {port} {marker.decode()} "
        f">/tmp/tunnel-{port}.log 2>&1 & echo $!",
    )
    assert result.exit_code == 0, result.stderr
    return result.stdout.strip()


async def _stop_service(box, pid: str) -> None:
    result = await box.exec("sh", "-lc", f"kill {shlex.quote(pid)}")
    assert result.exit_code == 0, result.stderr


async def _request(tunnel, request: bytes, *, read_delay: float = 0) -> bytes:
    connection = await tunnel.connect()
    try:
        await connection.write(request)
        if read_delay:
            await asyncio.sleep(read_delay)
        response = bytearray()
        while True:
            chunk = await asyncio.wait_for(
                connection.read(64 * 1024), timeout=10
            )
            if not chunk:
                return bytes(response)
            response.extend(chunk)
    finally:
        await connection.close()


async def _websocket_echo(tunnel, marker: bytes) -> bytes:
    connection = await tunnel.connect()
    key = base64.b64encode(b"boxlite-sdk-e2e").decode()
    try:
        await connection.write(
            (
                "GET /ws HTTP/1.1\r\nHost: tunnel.test\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode(),
        )
        headers = bytearray()
        while b"\r\n\r\n" not in headers:
            headers.extend(
                await asyncio.wait_for(connection.read(4096), timeout=5)
            )
        assert headers.startswith(b"HTTP/1.1 101")
        payload = b"python-ws"
        mask = b"\x01\x02\x03\x04"
        frame = (
            bytes([0x81, 0x80 | len(payload)])
            + mask
            + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        )
        await connection.write(frame)
        async def recv_exact(size: int) -> bytes:
            data = bytearray()
            while len(data) < size:
                chunk = await asyncio.wait_for(
                    connection.read(size - len(data)), timeout=5
                )
                if not chunk:
                    raise ConnectionError("WebSocket closed before the frame was complete")
                data.extend(chunk)
            return bytes(data)

        frame_header = await recv_exact(2)
        echoed = await recv_exact(frame_header[1] & 0x7F)
        assert echoed == marker + b":" + payload
        return echoed
    finally:
        await connection.close()


async def _wait_for_http(box: boxlite.SimpleBox, port: int, marker: bytes) -> bytes:
    deadline = asyncio.get_running_loop().time() + 30
    last_error: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            response = await _get_over_tunnel(box, port, marker)
            if marker in response:
                return response
            last_error = AssertionError(f"unexpected HTTP response: {response!r}")
        except (OSError, RuntimeError, asyncio.TimeoutError) as exc:
            last_error = exc
        await asyncio.sleep(0.25)
    raise AssertionError(
        f"guest HTTP service was not reachable through tunnel: {last_error}"
    )


@pytest.mark.asyncio
async def test_python_sdk_tunnel_proxies_http_from_rest_box(rt, image):
    """Cloud tunnels isolate ports, serve concurrent clients, and die with the box."""
    box = boxlite.SimpleBox(image=image, runtime=rt, auto_remove=True)
    async with box:
        pids = [await _start_service(box, port, marker) for port, marker in SERVICES]
        await _wait_for_http(box, *SERVICES[0])
        prepared_tunnel = await box.network.tunnel(SERVICES[0][0])

        expected = [service for service in SERVICES for _ in range(3)]
        responses = await asyncio.gather(
            *(_wait_for_http(box, port, marker) for port, marker in expected)
        )
        for response, (_, marker) in zip(responses, expected):
            assert response.startswith((b"HTTP/1.0 200", b"HTTP/1.1 200"))
            assert marker in response
            assert all(
                other not in response for _, other in SERVICES if other != marker
            )

        prepared_response = await _request(
            prepared_tunnel,
            b"GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        assert SERVICES[0][1] in prepared_response

        post_body = b"python-post" * 32768
        post_response = await _request(
            await box.network.tunnel(SERVICES[0][0]),
            b"POST / HTTP/1.0\r\nHost: tunnel.test\r\nContent-Length: "
            + str(len(post_body)).encode()
            + b"\r\n\r\n"
            + post_body,
        )
        assert hashlib.sha256(post_body).hexdigest().encode() in post_response

        large_response = await _request(
            await box.network.tunnel(SERVICES[0][0]),
            b"GET /large HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        assert len(large_response) > 2 * 1024 * 1024
        await _websocket_echo(await box.network.tunnel(SERVICES[0][0]), SERVICES[0][1])

        slow_response = await _request(
            await box.network.tunnel(SERVICES[0][0]),
            b"GET /slow HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
            read_delay=1,
        )
        assert len(slow_response) > 2 * 1024 * 1024

        cancelled = await (await box.network.tunnel(SERVICES[0][0])).connect()
        await cancelled.close()
        assert SERVICES[0][1] in await _wait_for_http(box, *SERVICES[0])

        await asyncio.gather(
            *(_wait_for_http(box, *SERVICES[index % 2]) for index in range(16))
        )

        await _stop_service(box, pids[0])
        pids[0] = await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])
        restart_response = await _request(
            await box.network.tunnel(SERVICES[0][0]),
            b"GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        assert SERVICES[0][1] in restart_response

    with pytest.raises((OSError, RuntimeError, asyncio.TimeoutError)):
        await asyncio.wait_for(box.network.tunnel(SERVICES[0][0]), timeout=10)


@pytest.mark.asyncio
async def test_python_sdk_tunnel_preserves_tcp_half_close(rt, image):
    async with boxlite.SimpleBox(image=image, runtime=rt, auto_remove=True) as box:
        await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])
        connection = await (await box.network.tunnel(SERVICES[0][0])).connect()
        await connection.write(
            b"GET / HTTP/1.0\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n",
        )
        await connection.shutdown_write()
        response = bytearray()
        while chunk := await asyncio.wait_for(
            connection.read(8192), timeout=5
        ):
            response.extend(chunk)
        await connection.close()
        assert SERVICES[0][1] in response


@pytest.mark.asyncio
async def test_python_sdk_tunnel_keeps_boxes_isolated(rt, image):
    boxes = [
        boxlite.SimpleBox(image=image, runtime=rt, auto_remove=True) for _ in range(2)
    ]
    async with boxes[0], boxes[1]:
        markers = (b"python-box-a", b"python-box-b")
        await asyncio.gather(
            *(
                _start_service(box, SERVICES[0][0], marker)
                for box, marker in zip(boxes, markers)
            )
        )
        responses = await asyncio.gather(
            *(
                _wait_for_http(box, SERVICES[0][0], marker)
                for box, marker in zip(boxes, markers)
            )
        )
        for response, marker, other in zip(responses, markers, reversed(markers)):
            assert marker in response
            assert other not in response
