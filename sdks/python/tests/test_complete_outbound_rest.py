"""Exercise complete policy through the Python SDK's native HTTP transport."""

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension module not built",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("deny", [{}, {"deny_net": []}, {"deny_net": ["example.com"]}])
async def test_complete_outbound_policy_requests(deny):
    import boxlite

    captured = []
    snapshot = {
        "revision": "r1",
        "admission": "extended_ipv4" if deny else "legacy",
        "policy": {
            "mode": "enabled",
            "allow_net": [],
            "deny_net": deny.get("deny_net", []),
        },
    }
    updated = {**snapshot, "revision": "r2"}
    resource = "/v1/org/boxes/complete-box/network/outbound/complete"
    metadata = {
        "box_id": "complete-box",
        "status": "running",
        "image": "alpine",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "cpus": 1,
        "memory_mib": 512,
    }
    replies = {
        ("GET", "/v1/config"): (
            200,
            {"capabilities": {"complete_outbound_policy_enabled": True}},
            None,
        ),
        ("POST", "/v1/org/boxes"): (201, metadata, None),
        ("GET", resource): (200, snapshot, '"r1"'),
        ("PUT", resource): (200, updated, '"r2"'),
        ("GET", resource + "/status"): (
            200,
            {
                "persisted": updated,
                "runtime_persisted": updated,
                "observed": {"snapshot": updated, "application_state": "confirmed"},
                "application_state": "pending",
            },
            None,
        ),
    }

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            captured.append(
                (
                    self.command,
                    self.path,
                    dict(self.headers.items()),
                    json.loads(body) if body else None,
                )
            )
            status, result, etag = replies[(self.command, self.path)]
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            if etag:
                self.send_header("ETag", etag)
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = answer

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        runtime = boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=f"http://127.0.0.1:{server.server_port}",
                path_prefix="org",
                credential=boxlite.ApiKeyCredential("test-token"),
            )
        )
        options = boxlite.BoxOptions("alpine")
        policy = {"mode": "enabled", **deny}
        with pytest.raises(boxlite.InvalidArgumentError):
            await runtime.create_with_outbound_policy(
                options, {"mode": "enabled", "deny_net": None}
            )
        assert captured == []
        box = await runtime.create_with_outbound_policy(options, policy)
        result = await box.network.replace_outbound_policy(policy, "r1")
        assert result["acknowledged"]["revision"] == "r2"
        assert result["status"]["application_state"] == "pending"
        assert result["application_verified"] is False
        assert [(method, path) for method, path, _, _ in captured] == [
            ("GET", "/v1/config"),
            ("POST", "/v1/org/boxes"),
            ("GET", resource),
            ("GET", resource),
            ("PUT", resource),
            ("GET", resource + "/status"),
        ]
        for _, _, headers, _ in captured:
            assert {key.lower(): value for key, value in headers.items()}[
                "authorization"
            ] == "Bearer test-token"
        assert {key.lower(): value for key, value in captured[4][2].items()}[
            "if-match"
        ] == '"r1"'
        for sent in [captured[1][3]["network"]["outbound"], captured[4][3]]:
            assert {
                key: value for key, value in sent.items() if key == "deny_net"
            } == deny

        replies[("POST", "/v1/org/boxes")] = (
            501,
            {
                "code": "unsupported",
                "creation_effect": "allocated",
                "box_id": "complete-box",
                "message": "Runner refused policy",
            },
            None,
        )
        with pytest.raises(boxlite.OutboundPolicyError) as caught:
            await runtime.create_with_outbound_policy(options, policy)
        failure = caught.value
        assert (failure.effect, failure.status, failure.box_id, failure.code) == (
            "allocated",
            501,
            "complete-box",
            "unsupported",
        )
        assert [(method, path) for method, path, _, _ in captured[6:]] == [
            ("GET", "/v1/config"),
            ("POST", "/v1/org/boxes"),
        ]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
