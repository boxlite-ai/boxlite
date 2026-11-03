"""One retained, environment-configured hostname across every public client."""

import asyncio
import fcntl
import hashlib
import os
import re
import tempfile
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from domain_client import CLIENTS, DomainClient
from e2e_auth import auth_context
from network_fixtures import PORT, prepare, service_box
from preview import PreviewURL, Reply, require

import boxlite

pytestmark = pytest.mark.e2e


@pytest.fixture
def subdomain_hostname():
    hostname = os.environ.get("BOXLITE_E2E_DOMAIN", "")
    if not hostname:
        pytest.skip(
            "set BOXLITE_E2E_DOMAIN to the organization's dedicated test hostname"
        )
    assert len(hostname) <= 253 and re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+",
        hostname,
    ), "BOXLITE_E2E_DOMAIN must be a lowercase full hostname without scheme or port"
    assert "PYTEST_XDIST_WORKER" not in os.environ, (
        "subdomain tests require serial execution"
    )
    assert auth_context().auth == "api-key", (
        "polyglot subdomain cases require AUTH=api-key"
    )
    # Shared across pytest invocations; a per-run tmp_path cannot serialize them.
    digest = hashlib.sha256(hostname.encode()).hexdigest()
    lock = Path(tempfile.gettempdir()) / f"boxlite-subdomain-{digest}.lock"
    with lock.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pytest.fail("another local run is using BOXLITE_E2E_DOMAIN")
        yield hostname


async def held_domain(rt, hostname):
    held = await rt.domains.list()
    return next((d for d in held.domains if d.hostname == hostname), None), held


@asynccontextmanager
async def domain_box(rt, image, hostname):
    current, _ = await held_domain(rt, hostname)
    assert current is None or current.target is None, (
        "test hostname is bound; inspect its target and explicitly unbind it before retrying"
    )
    assert current is not None, (
        "request the test hostname in Dashboard > Domains before running subdomain cases"
    )
    async with service_box(rt, image) as (box, marker):
        try:
            yield box, marker
        finally:
            current, _ = await held_domain(rt, hostname)
            if current is not None and current.target is not None:
                assert current.target.type == "box" and current.target.box == box.id, (
                    "test hostname moved to another target; refusing to unbind it"
                )
                assert await rt.domains.unbind(hostname) == ()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_request(uri):
    # Honor proxy env for remote developer machines. TLS verification stays on;
    # public URLs never receive the API key or follow a redirect.
    req = urllib.request.Request(
        uri, headers={"X-BoxLite-Skip-Preview-Warning": "true"}
    )
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(req, timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        body = response.read(8 * 1024 * 1024 + 1)
        require(len(body) <= 8 * 1024 * 1024, "public response exceeded probe limit")
        return Reply(response.status, body=body)


async def expect_http(uri, status, body=None, *, retry=()):
    uri = PreviewURL(uri)
    require(urlsplit(uri).scheme == "https", "cloud subdomain tests require HTTPS")
    deadline = asyncio.get_running_loop().time() + 35
    while True:
        response = await asyncio.to_thread(public_request, uri)
        if response.status == status:
            if body is not None:
                require(response.body == body, "subdomain reached the wrong guest port")
            return
        require(
            response.status in retry,
            f"expected HTTP {status}, received {response.status}",
        )
        require(
            asyncio.get_running_loop().time() < deadline,
            "public route never became ready",
        )
        await asyncio.sleep(0.2)


async def assert_list(client, hostname, box_id, port, quota):
    held = await client.call("list")
    matches = [d for d in held["domains"] if d["hostname"] == hostname]
    assert len(matches) == 1
    domain = matches[0]
    assert "name" not in domain
    assert domain["url"] == f"https://{hostname}"
    target = None if port is None else {"type": "box", "box": box_id, "port": port}
    if client.name == "cli" and port is not None:
        target = f"box {box_id}:{port}"
    assert domain["target"] == target
    if client.name != "cli":
        assert (held["limit"], held["used"], held["remaining"]) == quota
        assert held["min_length"] > 0


@pytest.mark.parametrize("sdk", CLIENTS)
async def test_subdomain_clients(subdomain_hostname, rt, image, tmp_path, sdk):
    hostname = subdomain_hostname
    client = DomainClient(sdk, tmp_path)
    async with domain_box(rt, image, hostname) as (box, marker):
        first = await prepare(box)
        await prepare(box, port=PORT + 1)
        await expect_http(first.uri(), 200, marker, retry=(502, 503))
        bound = await client.call("bind", hostname, PORT, box_id=box.id)
        if sdk == "cli":
            assert hostname in bound and f"{box.id}:{PORT}" in bound
        else:
            assert bound["hostname"] == hostname
            assert bound["target"] == {"type": "box", "box": box.id, "port": PORT}
        _, allowance = await held_domain(rt, hostname)
        quota = (allowance.limit, allowance.used, allowance.remaining)
        await assert_list(client, hostname, box.id, PORT, quota)
        await expect_http(f"https://{hostname}", 200, marker, retry=(502, 503))

        await client.call(
            "bind", f"{hostname}:4000", PORT, box_id=box.id, error="invalid domain"
        )
        await client.call(
            "bind", hostname.split(".")[0], PORT, box_id=box.id, error="bind requires a full hostname"
        )
        await client.call(
            "unbind", hostname.split(".")[0], error="unbind requires a full hostname"
        )
        await assert_list(client, hostname, box.id, PORT, quota)

        await client.call("bind", hostname, PORT + 1, box_id=box.id)
        await assert_list(client, hostname, box.id, PORT + 1, quota)
        await expect_http(
            f"https://{hostname}", 200, marker + b"-second", retry=(502, 503)
        )
        await client.call("unbind", hostname)
        await assert_list(client, hostname, box.id, None, quota)
        # Domain resolution is uncached: an acknowledged unbind must take effect now.
        await expect_http(f"https://{hostname}", 404)
        await client.call("unbind", hostname)
        await assert_list(client, hostname, box.id, None, quota)
        await expect_http(first.uri(), 200, marker)


async def test_subdomain_binding_does_not_publish_a_port(subdomain_hostname, rt, image):
    hostname = subdomain_hostname
    async with domain_box(rt, image, hostname) as (box, marker):
        bound = await rt.domains.bind(
            hostname, boxlite.DomainTarget(type="box", box=box.id, port=PORT)
        )
        assert bound.url == f"https://{hostname}"
        await expect_http(bound.url, 404)
        await prepare(box)
        await expect_http(bound.url, 200, marker, retry=(502, 503))
        await box.network.revoke_tunnel(PORT)
        await expect_http(bound.url, 404)
        retained, _ = await held_domain(rt, hostname)
        assert (retained.target.box, retained.target.port) == (box.id, PORT)
        await prepare(box, public=False)
        await expect_http(bound.url, 404)
