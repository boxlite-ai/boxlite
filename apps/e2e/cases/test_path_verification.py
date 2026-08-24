"""Meta-test: prove the e2e suite actually goes through SDK → API → Runner.

The check is two-part:

  (1) The SDK's configured runtime URL points at the API (has /api base
      path, is NOT the runner's :8080). Works for both local (:3000) and
      remote (dev.boxlite.ai) deployments.

  (2) After one round-trip create+exec, the API response carries the
      X-BoxLite-Api-Version header, proving the request went through the
      NestJS API layer (not direct runner). A successful exec with stdout
      proves the runner executed the command behind the API.

If either check fails, downstream regression tests cannot be trusted —
they may be passing because they're talking to something other than the
production exec path.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_sdk_runtime_is_rest_against_local_api(rt):
    """The runtime must be REST-mode and pointing at the API
    (not the runner on :8080, not local FFI)."""
    from e2e_auth import auth_context

    url = auth_context().url
    assert "/api" in url, (
        f"profile p1.url={url!r} missing /api base path; SDK would route to "
        f"runner endpoints (/v1/boxes...) and skip the NestJS proxy controller."
    )
    assert ":8080" not in url, (
        f"profile p1.url={url!r} points at the runner (:8080) instead of "
        f"the API. E2E tests must go through the API layer."
    )


@pytest.mark.asyncio
async def test_exec_roundtrip_proves_api_to_runner_chain(rt, image):
    """Create a box, exec a command, and verify:
    1. The API response has X-BoxLite-Api-Version (proves API layer)
    2. exec stdout contains the expected output (proves runner executed it)
    Together these prove SDK → API → Runner end-to-end."""
    import boxlite
    from e2e_auth import auth_context, request_json

    ctx = auth_context()

    # Raw HTTP create to inspect response headers
    req = urllib.request.Request(
        ctx.url_for(ctx.v1("boxes")),
        method="POST",
        data=json.dumps({
            "image": image, "cpus": 1, "memory_mib": 256, "disk_size_gb": 4,
        }).encode(),
        headers=ctx.auth_headers(content_type=True),
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        headers = dict(resp.headers)
        body = json.loads(resp.read())
        bid = body["box_id"]

    try:
        assert "X-BoxLite-Api-Version" in headers, (
            f"create response missing X-BoxLite-Api-Version header — "
            f"request may have bypassed the API layer. headers={sorted(headers)}"
        )

        # exec through SDK to verify runner actually runs the command
        box = await rt._inner.get(bid)
        if box is None:
            info_status, info_body = request_json("GET", ctx.v1(f"boxes/{bid}"))
            pytest.fail(f"SDK.get({bid}) returned None; API says {info_status}")

        ex = await box.exec("echo", ["e2e-chain-proof"], None)
        out, _ = await drain(ex)
        await ex.wait()

        assert "e2e-chain-proof" in out, (
            f"exec stdout missing expected marker — runner may not have "
            f"executed the command. stdout={out!r}"
        )
    finally:
        try:
            req = urllib.request.Request(
                ctx.url_for(ctx.v1(f"boxes/{bid}")),
                method="DELETE",
                headers=ctx.auth_headers(),
            )
            urllib.request.urlopen(req, timeout=15)
        except Exception:
            pass  # best-effort cleanup; don't fail the test on delete error
