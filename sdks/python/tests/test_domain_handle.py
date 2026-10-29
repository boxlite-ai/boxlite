"""
The organization's domains through the native binding (no VM required).

A local runtime refuses the handle outright; a REST runtime is pointed at a
loopback stub, so what it sends and reads crosses a real HTTP boundary.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import pytest_asyncio

import boxlite

pytestmark = pytest.mark.skipif(
    not hasattr(boxlite, "Boxlite"), reason="native Rust extension not available"
)

BOUND = {
    "hostname": "demo1.app.test",
    "url": "https://demo1.app.test",
    "target": {"type": "box", "box": "AbCdEf123456", "port": 3000},
}


@pytest_asyncio.fixture
async def local_runtime(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    yield runtime
    await runtime.shutdown()


def test_a_local_runtime_has_no_domains(local_runtime):
    with pytest.raises(boxlite.UnsupportedError):
        _ = local_runtime.domains


def test_a_target_is_keyword_only_and_names_its_type():
    target = boxlite.DomainTarget(type="box", box="web-a", port=3000)
    assert (target.type, target.box, target.port) == ("box", "web-a", 3000)
    with pytest.raises(TypeError):
        boxlite.DomainTarget("box", "web-a", 3000)
    with pytest.raises(ValueError, match="app"):
        boxlite.DomainTarget(type="app", box="shop", port=1)


@pytest.fixture
def server():
    """A box API stub answering each (method, path) with a fixed reply.

    Yields its URL, the replies to fill in, and every (method, path, body) it
    received. A route with no reply answers 404.
    """
    replies: dict = {}
    requests: list = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            requests.append((self.command, self.path, body))
            status, reply = replies.get(
                (self.command, self.path), (404, {"message": "no route"})
            )
            payload = b"" if reply is None else json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_PUT = do_DELETE = _answer

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{http.server_address[1]}", replies, requests
    http.shutdown()
    http.server_close()


def domains_on(url):
    return boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url)).domains


@pytest.mark.asyncio
async def test_bind_puts_the_target_and_reads_the_bound_domain(server):
    url, replies, requests = server
    replies[("PUT", "/v1/domains/demo1/target")] = (200, BOUND)

    bound = await domains_on(url).bind(
        "demo1", boxlite.DomainTarget(type="box", box="web-a", port=3000)
    )

    [(_, _, body)] = requests
    assert json.loads(body) == {"type": "box", "box": "web-a", "port": 3000}
    assert (bound.hostname, bound.url) == ("demo1.app.test", "https://demo1.app.test")
    assert (bound.target.type, bound.target.box, bound.target.port) == (
        "box",
        "AbCdEf123456",
        3000,
    )
    replies[("PUT", "/v1/domains/shop1/target")] = (
        200,
        {
            **BOUND,
            "hostname": "shop1.app.test",
            "url": "https://shop1.app.test",
            "target": {"type": "app", "app": "shop"},
        },
    )
    app = await domains_on(url).bind(
        "shop1", boxlite.DomainTarget(type="app", app="shop")
    )
    assert json.loads(requests[-1][2]) == {"type": "app", "app": "shop"}
    assert (app.target.type, app.target.app, app.target.box, app.target.port) == (
        "app",
        "shop",
        None,
        None,
    )


@pytest.mark.asyncio
async def test_list_reads_unbound_domains_and_the_allowance(server):
    url, replies, _ = server
    replies[("GET", "/v1/domains")] = (
        200,
        {
            "domains": [
                BOUND,
                {
                    **BOUND,
                    "hostname": "spare.app.test",
                    "url": "https://spare.app.test",
                    "target": None,
                },
                {
                    **BOUND,
                    "hostname": "shop.app.test",
                    "url": "https://shop.app.test",
                    "target": {"type": "app", "app": "shop"},
                },
            ],
            "limit": 3,
            "used": 3,
            "remaining": 0,
            "min_length": 5,
        },
    )

    held = await domains_on(url).list()

    assert [domain.hostname for domain in held.domains] == [
        "demo1.app.test",
        "spare.app.test",
        "shop.app.test",
    ]
    assert all(not hasattr(domain, "name") for domain in held.domains)
    assert (held.domains[2].target.type, held.domains[2].target.app) == ("app", "shop")
    assert held.domains[1].target is None
    assert (held.limit, held.used, held.remaining, held.min_length) == (3, 3, 0, 5)


@pytest.mark.asyncio
async def test_unbind_deletes_the_target(server):
    url, replies, requests = server
    replies[("DELETE", "/v1/domains/demo1.app.test/target")] = (204, None)

    with pytest.raises(boxlite.InvalidArgumentError):
        await domains_on(url).unbind("demo1")
    assert requests == []
    await domains_on(url).unbind("demo1.app.test")

    assert [(method, path) for method, path, _ in requests] == [
        ("DELETE", "/v1/domains/demo1.app.test/target")
    ]
