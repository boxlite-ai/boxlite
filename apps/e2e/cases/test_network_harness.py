"""POL-1221: test the E2E assertions themselves without a cloud credential."""
from types import SimpleNamespace
import importlib
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import test_sdk_tunnel
from test_network_egress import _reaches
from network_fixtures import eventually_status


@pytest.fixture(autouse=True)
def verify_runner_saw_all_boxes():
    yield  # These tests exercise the harness, not a remote box.


@pytest.mark.parametrize("expected,status,accepted", [
    ((403, 404), 403, True),
    ((403, 404), 404, True),
    ((403, 404), 200, False),
    ((403, 404), 401, False),
    ((403, 404), 500, False),
    (404, 403, False),
    (404, 404, True),
])
async def test_network_harness_expected_statuses(expected, status, accepted):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        uri = f"http://127.0.0.1:{server.server_port}/"
        if accepted:
            reply = await eventually_status(uri, "http", expected)
            assert reply.status == status
        else:
            with pytest.raises(AssertionError, match="after cache window"):
                await eventually_status(uri, "http", expected)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


async def test_network_harness_required_identity_cannot_skip(monkeypatch):
    import test_preview_access as case

    monkeypatch.delenv("BOXLITE_E2E_READONLY_PROFILE", raising=False)
    monkeypatch.setenv("BOXLITE_E2E_REQUIRE_IDENTITIES", "1")
    try:
        with pytest.raises(pytest.fail.Exception, match="required identity"):
            await case.test_preview_private_identity_permissions(None, None, None, "readonly")
    except pytest.skip.Exception:
        pytest.fail("required identity was silently skipped")


@pytest.mark.parametrize("identity,prefix", [("readonly", "foreign-org"), ("foreign", "owner-org")])
async def test_network_harness_wrong_identity_fails_before_creating_box(monkeypatch, identity, prefix):
    import test_preview_access as case

    owner = SimpleNamespace(url="https://api.example", path_prefix="owner-org")
    monkeypatch.setenv(f"BOXLITE_E2E_{identity.upper()}_PROFILE", "probe")
    monkeypatch.setattr(case, "load_profile", lambda _: {"url": owner.url, "api_key": "probe-key"})
    # raising=False also permits the pre-fix case, which did not discover identity.
    monkeypatch.setattr(case, "discover_path_prefix", lambda *_: prefix, raising=False)

    def create_before_validation(*_args):
        raise AssertionError("box creation reached before identity validation")

    monkeypatch.setattr(case, "service_box", create_before_validation)
    with pytest.raises(AssertionError, match="wrong organization relationship"):
        await case.test_preview_private_identity_permissions(None, None, owner, identity)


@pytest.mark.parametrize("setting,url", [
    ("BOXLITE_E2E_EGRESS_IP_URL", "https://example.com/"),
    ("BOXLITE_E2E_EGRESS_WILDCARD_URL", "http://www.example.com/"),
])
def test_network_harness_rule_probes_reject_mismatched_targets(monkeypatch, setting, url):
    import test_network_updates

    try:
        with monkeypatch.context() as configuration:
            configuration.setenv(setting, url)
            with pytest.raises(ValueError):
                importlib.reload(test_network_updates)
    finally:
        importlib.reload(test_network_updates)


class Execution:
    def __init__(self, output, code):
        self.output, self.code = output, code

    async def stdout(self):
        yield self.output

    async def stderr(self):
        yield ""

    async def wait(self):
        return SimpleNamespace(exit_code=self.code)


class ProbeBox:
    def __init__(self, output, code=0):
        self.execution = Execution(output, code)

    async def exec(self, *_args):
        return self.execution


@pytest.mark.parametrize("output,code", [("", 0), ("BLOCKED\n", 127)])
async def test_network_harness_rejects_missing_or_failed_probe(output, code):
    with pytest.raises(AssertionError):
        await _reaches(ProbeBox(output, code), "example.com")


class FramedConnection:
    def __init__(self):
        self.chunks = iter([b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r", b"\nbo", b"dy"])
        self.closed = False

    async def write(self, _request):
        pass

    async def read(self, _size):
        try:
            return next(self.chunks)
        except StopIteration:
            raise RuntimeError("peer closed connection without sending TLS close_notify")

    async def close(self):
        self.closed = True


async def test_network_harness_reads_complete_http_without_waiting_for_tls_eof():
    connection = FramedConnection()

    class Tunnel:
        async def connect(self):
            return connection

    response = await test_sdk_tunnel._request(Tunnel(), b"GET / HTTP/1.1\r\nHost: example.test\r\n\r\n")
    assert response.endswith(b"\r\n\r\nbody")
    assert connection.closed


@pytest.mark.parametrize("status", [b"200 OK", b"502 Bad Gateway"])
async def test_network_harness_half_close_does_not_hide_complete_wrong_response(monkeypatch, status):
    chunks = iter([b"HTTP/1.1 " + status + b"\r\nContent-Length: 5\r\n\r\nwrong", b""])

    async def ignore(*_args, **_kwargs):
        pass

    async def read(_size):
        return next(chunks)

    async def connect():
        return SimpleNamespace(write=ignore, read=read, close=ignore, shutdown_write=ignore)

    async def tunnel(*_args):
        return SimpleNamespace(connect=connect)

    async def create(*_args):
        return SimpleNamespace(id="harness", network=SimpleNamespace(tunnel=tunnel))

    monkeypatch.setattr(test_sdk_tunnel, "_start_service", ignore)
    monkeypatch.setattr(test_sdk_tunnel, "_wait_for_http", ignore)
    with pytest.raises(AssertionError) as failure:
        await test_sdk_tunnel.test_python_sdk_tunnel_preserves_tcp_half_close(
            SimpleNamespace(create=create, remove=ignore), "unused",
        )
    assert not isinstance(failure.value, test_sdk_tunnel.HalfCloseResponseLost), (
        "complete wrong responses must fail, not match the known half-close xfail"
    )


def test_network_harness_node_framing_and_websocket_echo():
    if not shutil.which("node"):
        pytest.skip("Node is required to verify its tunnel probe")
    helper = Path(__file__).parents[1] / "sdks/node/tunnel-probes.mjs"
    result = subprocess.run(["node", "--input-type=module", "-", helper.as_uri()], input=r'''
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const { readHttp, websocketEcho } = await import(process.argv[2])
const chunks = [Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r'), Buffer.from('\nbody')]
assert((await readHttp({read: async () => {
  assert(chunks.length, 'read past framed HTTP response')
  return chunks.shift()
}})).toString().endsWith('\r\n\r\nbody'))
await assert.rejects(() => readHttp({read: async () => Buffer.alloc(0)}), /closed before/)
for (const echo of [null, 'wrong', 'guest:node-ws']) {
  let data = Buffer.alloc(0)
  const socket = {
    write: async bytes => {
      if (bytes.toString().startsWith('GET')) {
        const key = bytes.toString().match(/Sec-WebSocket-Key: (.*)\r\n/)[1]
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        data = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      } else if (echo !== null) {
        data = Buffer.concat([Buffer.from([0x81, echo.length]), Buffer.from(echo)])
      }
    },
    read: async size => { const next = data.subarray(0, size); data = data.subarray(size); return next },
  }
  if (echo === 'guest:node-ws') await websocketEcho(socket, 'guest')
  else await assert.rejects(() => websocketEcho(socket, 'guest'), /closed before echo|echo mismatch/)
}
''', text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_network_harness_egress_does_not_follow_redirect_to_another_target():
    paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            self.send_response(302 if self.path == "/redirect" else 200)
            self.send_header("Location", f"http://localhost:{self.server.server_port}/unlisted")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        probe = Path(__file__).parents[1] / "fixtures/egress_probe.py"
        result = subprocess.run([sys.executable, str(probe), f"http://127.0.0.1:{server.server_port}/redirect"],
                                text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert '"reachable": true' in result.stdout
        assert paths == ["/redirect"], "probe followed a redirect and changed the destination under test"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
