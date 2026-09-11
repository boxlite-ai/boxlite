"""Per-box network rate limit, end to end: SDK (REST) → API → Runner → VM.

The cap rides as `advanced.network_rate_limit` on the BoxLite REST surface,
lands on the Box row, and reaches the runner's CreateBoxDTO and the gvproxy
shaper through the Go SDK. Two things are proven here that unit tests cannot:

1. the hosted API advertises the capability the Rust client gates on, and
   refuses a cap it could not honour with a 4xx rather than a failed job;
2. a capped box is measurably slower than an uncapped one, per direction.

Throughput is measured against a payload server on the pytest host, reached
from the guest at gvproxy's host alias, so a flaky public internet cannot fail
the test. When the runner is not on this host (cloud CI) the alias points
elsewhere and the throughput cases skip, the way test_network_curl skips
without guest networking.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import drain

import boxlite

# gvproxy's alias for the machine running the runner
# (src/boxlite/src/net/constants.rs, HOST_IP).
GVPROXY_HOST = "192.168.127.254"
PAYLOAD_BYTES = 4 * 1024 * 1024
# 1 MiB/s: the 4 MiB payload takes ~4 s capped and well under a second
# uncapped on any host this suite runs on, so both assertions below have a
# wide margin.
CAPPED_KBPS = 8_000
MIN_CAPPED_SECONDS = 3.0
MIN_SLOWDOWN = 3.0


class _PayloadHandler(BaseHTTPRequestHandler):
    payload = b"\0" * PAYLOAD_BYTES

    def do_GET(self):  # http.server API spelling
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(self.payload)))
        self.end_headers()
        self.wfile.write(self.payload)

    def _sink(self):
        remaining = int(self.headers.get("Content-Length", "0"))
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                break
            remaining -= len(chunk)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    do_PUT = _sink  # http.server API spelling
    do_POST = _sink  # http.server API spelling

    def log_message(self, *_args):
        """Keep the pytest log free of one line per transfer."""


@pytest.fixture(scope="module")
def payload_port() -> int:
    server = ThreadingHTTPServer(("0.0.0.0", 0), _PayloadHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()


def _capped(image: str, **limit: int) -> boxlite.BoxOptions:
    return boxlite.BoxOptions(
        image=image,
        auto_remove=True,
        advanced=boxlite.AdvancedBoxOptions(
            network_rate_limit=boxlite.NetworkRateLimit(**limit),
        ),
    )


def _download(port: int) -> str:
    url = f"http://{GVPROXY_HOST}:{port}/payload"
    return f"wget -q -O /dev/null {url} || curl -fsS -o /dev/null {url}"


def _upload(port: int) -> str:
    url = f"http://{GVPROXY_HOST}:{port}/sink"
    return (
        f"head -c {PAYLOAD_BYTES} /dev/zero > /tmp/payload && "
        f"(wget -q -O /dev/null --post-file=/tmp/payload {url} || "
        f"curl -fsS -o /dev/null -T /tmp/payload {url})"
    )


async def _timed(box, command: str) -> tuple[float, int, str]:
    """Wall time, exit code and output of one transfer in the guest."""
    ex = await box.exec("sh", ["-c", command])
    started = time.monotonic()
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=180)
    return time.monotonic() - started, rc.exit_code, f"{err!r} {out!r}"


async def _uncapped_baseline(rt, image: str, command: str) -> float:
    """Best of two uncapped runs: a loaded host can only slow this leg down,
    which would shrink the slowdown ratio and let a dropped cap pass.

    This is the one place a transfer may fail softly: an unreachable payload
    server on an uncapped box means the runner is not on this host, so the
    throughput cases skip. The capped box below gets no such excuse."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        samples = []
        for _ in range(2):
            elapsed, exit_code, output = await _timed(box, command)
            if exit_code != 0:
                pytest.skip(
                    f"payload server not reachable from the guest (remote runner?): {output}"
                )
            samples.append(elapsed)
        return min(samples)
    finally:
        await rt.remove(box.id, force=True)


async def _capped_transfer(rt, image: str, command: str, **limit: int) -> float:
    """The same transfer on a capped box. A failure here is a real one — the
    baseline already proved the server reachable — so it fails the test rather
    than skipping it; a shaper that broke connections would otherwise hide."""
    box = await rt.create(_capped(image, **limit))
    try:
        elapsed, exit_code, output = await _timed(box, command)
    finally:
        await rt.remove(box.id, force=True)
    assert exit_code == 0, f"transfer failed on the capped box: {output}"
    return elapsed


def test_config_advertises_network_rate_limit(e2e_auth):
    """The Rust client refuses to send a cap unless this key is true, so an
    API that carries the field but forgets to say so is unusable."""
    req = urllib.request.Request(
        e2e_auth.url_for(e2e_auth.v1("config")),
        headers=e2e_auth.auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        config = json.load(response)

    assert config["capabilities"]["network_rate_limit_enabled"] is True


def test_capped_create_on_a_blocked_network_is_rejected_at_the_api(e2e_auth, image):
    """Raw HTTP on purpose: the SDK refuses this pairing client-side before a
    request leaves, so only a hand-built body reaches the server's rule. A
    5xx here would mean the API accepted a job the runner is bound to fail."""
    body = json.dumps(
        {
            "image": image,
            "network": {"outbound": {"mode": "disabled"}},
            "advanced": {"network_rate_limit": {"rx_kbps": CAPPED_KBPS}},
        }
    ).encode()
    req = urllib.request.Request(
        e2e_auth.url_for(e2e_auth.v1("boxes")),
        data=body,
        method="POST",
        headers=e2e_auth.auth_headers(content_type=True),
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        exc.read()
        assert exc.code == 400, f"expected a 400, got {exc.code}"
    else:
        pytest.fail("a cap on a box with no outbound network must be rejected")


@pytest.mark.asyncio
async def test_rx_cap_slows_downloads(rt, image, payload_port):
    """rx is what reaches the box: a download from the host must crawl."""
    command = _download(payload_port)
    baseline = await _uncapped_baseline(rt, image, command)

    capped = await _capped_transfer(rt, image, command, rx_kbps=CAPPED_KBPS)

    assert capped >= MIN_CAPPED_SECONDS, f"rx cap not applied: 4 MiB arrived in {capped:.2f}s"
    assert capped >= MIN_SLOWDOWN * baseline, (
        f"rx cap barely slowed the box: {capped:.2f}s capped vs {baseline:.2f}s uncapped"
    )


@pytest.mark.asyncio
async def test_tx_cap_slows_uploads(rt, image, payload_port):
    """tx is what the box sends: an upload to the host must crawl."""
    command = _upload(payload_port)
    baseline = await _uncapped_baseline(rt, image, command)

    capped = await _capped_transfer(rt, image, command, tx_kbps=CAPPED_KBPS)

    assert capped >= MIN_CAPPED_SECONDS, f"tx cap not applied: 4 MiB left in {capped:.2f}s"
    assert capped >= MIN_SLOWDOWN * baseline, (
        f"tx cap barely slowed the box: {capped:.2f}s capped vs {baseline:.2f}s uncapped"
    )
