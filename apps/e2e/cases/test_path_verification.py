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
import asyncio

import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

import pytest

from conftest import drain, with_bounded_lifetime
from path_verification import (
    API_LOG, RUNNER_LOG, api_log_seek, api_hits_for_box,
    runner_journal_seek, runner_hits_for_box,
)


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


@pytest.mark.smoke
@pytest.mark.asyncio
async def test_exec_roundtrip_proves_api_to_runner_chain(rt, image):
    """Create a box, exec a command, and verify:
    1. The API response has X-BoxLite-Api-Version (proves API layer)
    2. exec stdout contains the expected output (proves runner executed it)
    Together these prove SDK → API → Runner end-to-end."""
    import boxlite
    from e2e_auth import auth_context, request_json

    ctx = auth_context()
    api_before = api_log_seek()
    runner_before = runner_journal_seek()

    # Raw HTTP create to inspect response headers
    req = urllib.request.Request(
        ctx.url_for(ctx.v1("boxes")),
        method="POST",
        data=json.dumps(with_bounded_lifetime({
            "image": image, "cpus": 1, "memory_mib": 256, "disk_size_gb": 4,
        })).encode(),
        headers=ctx.auth_headers(content_type=True),
    )
    # A fresh Runner downloads and builds the image before create responds.
    with urllib.request.urlopen(req, timeout=120) as resp:
        # `resp.headers` looks up case-insensitively; `dict()` of it does not.
        # A cloud stage behind an HTTP/2 load balancer sends header names
        # lowercased, so the `dict()` form failed against api.dev.boxlite.ai
        # on a header the response was in fact carrying
        # (`x-boxlite-api-version: 0.0.1`).
        api_version = resp.headers.get("X-BoxLite-Api-Version")
        header_names = sorted(resp.headers.keys())
        body = json.loads(resp.read())
        bid = body["box_id"]

    try:
        assert api_version, (
            f"create response missing X-BoxLite-Api-Version header — "
            f"request may have bypassed the API layer. headers={header_names}"
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

        local_api = urllib.parse.urlparse(ctx.url).hostname in ("127.0.0.1", "localhost")
        if os.environ.get("BOXLITE_E2E_API_LOG") or (local_api and API_LOG.exists()):
            status, _ = request_json("GET", ctx.v1(f"boxes/{bid}"))
            assert status == 200, f"GET box {bid} failed: {status}"
            # The development Pino transport writes from a worker thread.
            deadline = asyncio.get_running_loop().time() + 5
            while api_hits_for_box(api_before, bid) < 1 and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
            assert api_hits_for_box(api_before, bid) >= 1, (
                f"API log has no request for box {bid} since create"
            )
        if RUNNER_LOG:
            assert runner_hits_for_box(runner_before, bid) >= 1, (
                f"Runner log has no event for box {bid} since create"
            )
            with Path(RUNNER_LOG).open("rb") as runner_log:
                runner_log.seek(int(runner_before))
                lines = runner_log.read().decode("utf-8", errors="replace").splitlines()
            assert any(
                bid in line and "CREATE_BOX" in line
                and "Job completed successfully" in line
                for line in lines
            ), f"Runner log has no successful CREATE_BOX event for box {bid}"
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
