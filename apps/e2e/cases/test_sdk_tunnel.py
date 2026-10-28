"""REST E2E coverage for the Python SDK's public network handle."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from pathlib import Path
import shlex

import boxlite
import pytest

from conftest import TUNNEL_READ_TO_EOF_XFAIL, drain
from http_frames import HalfCloseResponseLost, UnexpectedTunnelEOF, response_size

SERVICES = ((18080, b"python-sdk-tunnel-e2e-a"), (18082, b"python-sdk-tunnel-e2e-b"))
FIXTURE = Path(__file__).parents[1] / "fixtures" / "service_in_box_server.py"


def tunnelable_box(image: str, **options) -> boxlite.BoxOptions:
    """Options for a box a tunnel can actually be opened on.

    Inbound is the box-wide switch; public/private is chosen per tunnel.
    """
    return boxlite.BoxOptions(
        image=image,
        network=boxlite.NetworkSpec(inbound=boxlite.InboundNetworkSpec(mode="enabled")),
        **options,
    )


async def _get_over_tunnel(box: boxlite.Box, port: int, marker: bytes) -> bytes:
    tunnel = await box.network.tunnel(("127.0.0.1", port))
    return await _request(tunnel, b"GET /marker.txt HTTP/1.0\r\nHost: tunnel.test\r\n\r\n")


async def _start_service(box, port: int, marker: bytes) -> str:
    encoded = base64.b64encode(FIXTURE.read_bytes()).decode()
    code = f"import base64;exec(base64.b64decode({encoded!r}))"
    ex = await box.exec(
        "sh",
        [
            "-lc",
            f"python3 -u -c {shlex.quote(code)} {port} {marker.decode()} "
            f">/tmp/tunnel-{port}.log 2>&1 & echo $!",
        ],
    )
    out, err = await asyncio.wait_for(drain(ex), timeout=30)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, err
    return out.strip()


async def _stop_service(box, pid: str) -> None:
    ex = await box.exec("sh", ["-lc", f"kill {shlex.quote(pid)}"])
    _, err = await asyncio.wait_for(drain(ex), timeout=30)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, err


async def _request(tunnel, request: bytes, *, read_delay: float = 0, read_eof=False) -> bytes:
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
                raise AssertionError("tunnel closed before the complete HTTP response")
            response.extend(chunk)
            size = response_size(response)
            if size is not None and len(response) >= size:
                assert len(response) == size, "unexpected bytes after the HTTP response"
                if read_eof:
                    try:
                        assert not await asyncio.wait_for(connection.read(1), timeout=5)
                    except RuntimeError as error:
                        if "without sending TLS close_notify" in str(error):
                            raise UnexpectedTunnelEOF("complete response followed by missing TLS close_notify") from None
                        raise
                return bytes(response)
    finally:
        await connection.close()


async def _websocket_echo(tunnel, marker: bytes) -> bytes:
    connection = await tunnel.connect()
    key = base64.b64encode(b"boxlite-e2e-key!!").decode()
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
            chunk = await asyncio.wait_for(connection.read(4096), timeout=5)
            assert chunk, "WebSocket closed before upgrade"
            headers.extend(chunk)
            assert len(headers) <= 65536, "WebSocket headers exceed probe limit"
        assert headers.startswith(b"HTTP/1.1 101")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        fields = dict(line.split(b":", 1) for line in bytes(headers).split(b"\r\n")[1:] if b":" in line)
        assert next(value.strip() for name, value in fields.items() if name.lower() == b"sec-websocket-accept") == accept
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
        assert frame_header[0] == 0x81 and frame_header[1] < 126, "unexpected WebSocket echo frame"
        echoed = await recv_exact(frame_header[1] & 0x7F)
        assert echoed == marker + b":" + payload
        return echoed
    finally:
        await connection.close()


async def _wait_for_http(box: boxlite.Box, port: int, marker: bytes) -> bytes:
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
    box = await rt.create(tunnelable_box(image))
    try:
        pids = [await _start_service(box, port, marker) for port, marker in SERVICES]
        await _wait_for_http(box, *SERVICES[0])
        prepared_tunnel = await box.network.tunnel(("127.0.0.1", SERVICES[0][0]))

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
            await box.network.tunnel(("127.0.0.1", SERVICES[0][0])),
            b"POST / HTTP/1.0\r\nHost: tunnel.test\r\nContent-Length: "
            + str(len(post_body)).encode()
            + b"\r\n\r\n"
            + post_body,
        )
        assert hashlib.sha256(post_body).hexdigest().encode() in post_response

        large_response = await _request(
            await box.network.tunnel(("127.0.0.1", SERVICES[0][0])),
            b"GET /large HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        assert len(large_response) > 2 * 1024 * 1024
        await _websocket_echo(await box.network.tunnel(("127.0.0.1", SERVICES[0][0])), SERVICES[0][1])

        slow_response = await _request(
            await box.network.tunnel(("127.0.0.1", SERVICES[0][0])),
            b"GET /slow HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
            read_delay=1,
        )
        assert len(slow_response) > 2 * 1024 * 1024

        cancelled = await (await box.network.tunnel(("127.0.0.1", SERVICES[0][0]))).connect()
        await cancelled.close()
        assert SERVICES[0][1] in await _wait_for_http(box, *SERVICES[0])

        await asyncio.gather(
            *(_wait_for_http(box, *SERVICES[index % 2]) for index in range(16))
        )

        await _stop_service(box, pids[0])
        pids[0] = await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])
        restart_response = await _request(
            await box.network.tunnel(("127.0.0.1", SERVICES[0][0])),
            b"GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n",
        )
        assert SERVICES[0][1] in restart_response
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_python_sdk_tunnel_rejects_stopped_box(rt, image):
    # A box auto-resumes unless created otherwise, and the API wakes such a
    # box for a tunnel rather than refusing it.
    box = await rt.create(tunnelable_box(image, auto_resume=False))
    try:
        await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])

        # stop(), not remove(): this test is about tunnelling into a box
        # that's merely stopped, not one that's gone.
        await box.stop()
        deadline = asyncio.get_running_loop().time() + 30
        while await _box_status(rt, box.id) != "stopped":
            assert asyncio.get_running_loop().time() < deadline, "box never stopped"
            await asyncio.sleep(0.2)

        # A stopped, non-auto-resumable box must reject the tunnel request
        # up front (POL-214) rather than handing back a URI that CONNECTs
        # successfully and then silently drops the stream.
        with pytest.raises(boxlite.InvalidStateError, match="not running"):
            await asyncio.wait_for(box.network.tunnel(("127.0.0.1", SERVICES[0][0])), timeout=10)
    finally:
        await rt.remove(box.id, force=True)


async def _box_status(rt, box_id: str) -> str:
    return (await rt.get_info(box_id)).state.status


@pytest.mark.asyncio
async def test_python_sdk_tunnel_connect_wakes_stopped_box(rt, image):
    """POL-599: the first connection to a stopped auto-resume box wakes it
    through the API and reaches its service, instead of failing with a bare
    502. Preparing the tunnel alone must not wake the box."""
    port, marker = SERVICES[0]
    encoded = base64.b64encode(FIXTURE.read_bytes()).decode()
    code = f"import base64;exec(base64.b64decode({encoded!r}))"
    # The service is the box's own command, so it comes back when the box boots.
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_remove=False,
            auto_resume=True,
            network=boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(mode="enabled"),
                inbound=boxlite.InboundNetworkSpec(mode="enabled"),
            ),
            entrypoint=["python3", "-u", "-c", code, str(port), marker.decode()],
        )
    )
    try:
        await _wait_for_http(box, port, marker)

        await box.stop()
        deadline = asyncio.get_running_loop().time() + 60
        while await _box_status(rt, box.id) != "stopped":
            assert asyncio.get_running_loop().time() < deadline, "box never stopped"
            await asyncio.sleep(1)

        tunnel = await box.network.tunnel(("127.0.0.1", port))
        assert await _box_status(rt, box.id) == "stopped"

        response = await _request(
            tunnel, b"GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n"
        )
        assert response.startswith((b"HTTP/1.0 200", b"HTTP/1.1 200")), response[:200]
        assert marker in response
        assert await _box_status(rt, box.id) == "running"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.xfail(
    strict=True,
    raises=HalfCloseResponseLost,
    reason="TCP half-close currently drops the guest response",
)
@pytest.mark.asyncio
async def test_python_sdk_tunnel_preserves_tcp_half_close(rt, image):
    box = await rt.create(tunnelable_box(image))
    try:
        await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])
        connection = await (await box.network.tunnel(("127.0.0.1", SERVICES[0][0]))).connect()
        await connection.write(
            b"GET / HTTP/1.0\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n",
        )
        await connection.shutdown_write()
        response = bytearray()
        try:
            try:
                while chunk := await asyncio.wait_for(connection.read(8192), timeout=5):
                    response.extend(chunk)
                    length = response_size(response)
                    if length is not None and len(response) >= length:
                        break
            except RuntimeError as error:
                if "without sending TLS close_notify" not in str(error):
                    raise
            length = response_size(response)
            if length is None or len(response) < length:
                raise HalfCloseResponseLost("working tunnel lost its response after half-close")
            assert response.split(b"\r\n\r\n", 1)[1] == SERVICES[0][1], "half-close reached the wrong guest"
        finally:
            await connection.close()
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_python_sdk_tunnel_keeps_boxes_isolated(rt, image):
    # Appended one at a time inside try, not built as a list literal before
    # it: if the second create() raised, the first box would already exist
    # remotely but `boxes` would never be assigned, so `finally` couldn't
    # see it to clean it up.
    boxes = []
    try:
        for _ in range(2):
            boxes.append(
                await rt.create(tunnelable_box(image))
            )
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
    finally:
        for box in boxes:
            try:
                await rt.remove(box.id, force=True)
            except Exception:
                pass


@TUNNEL_READ_TO_EOF_XFAIL
@pytest.mark.asyncio
async def test_python_sdk_tunnel_tls_shutdown(rt, image):
    box = await rt.create(tunnelable_box(image))
    try:
        await _start_service(box, *SERVICES[0])
        await _wait_for_http(box, *SERVICES[0])
        tunnel = await box.network.tunnel(("127.0.0.1", SERVICES[0][0]))
        await _request(tunnel, b"GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n", read_eof=True)
    finally:
        await rt.remove(box.id, force=True)
