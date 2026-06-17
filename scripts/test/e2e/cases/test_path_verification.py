"""Meta-test: prove the e2e suite actually goes through SDK → API → Runner.

The check is two-part:

  (1) The SDK's configured runtime URL points at the API (has /api base
      path, is NOT the runner's :8080). Works for both local (:3000) and
      remote (dev.boxlite.ai) deployments.

  (2) After one round-trip exec, the runner journal contains the box id.
      Runner journal entries (`CREATE_BOX` / `created box id=…
      name=<uuid>`) only ever appear when the API queued the job. A single
      runner-journal hit is sufficient evidence for the whole chain.
      Skipped when BOXLITE_E2E_SKIP_PATH_VERIFY=1 (remote runs).

If either check fails, downstream regression tests cannot be trusted —
they may be passing because they're talking to something other than the
production exec path.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box
from conftest import drain


@pytest.mark.asyncio
async def test_sdk_runtime_is_rest_against_local_api(rt):
    """The runtime must be REST-mode and pointing at the API
    (not the runner on :8080, not local FFI)."""
    # Boxlite.rest() always wires REST; check the URL the SDK is actually
    # going to use by inspecting the credentials we built it from.
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
async def test_exec_reaches_runner_journal(rt, image):
    """One round-trip exec must leave the runner journal with the box id.
    Runner only sees box ids the API queued for it, so a hit here =
    proof that SDK→API→Runner went through end-to-end."""
    import boxlite

    runner_before = runner_journal_seek()
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec("cat", ["/etc/os-release"], None)
        await drain(ex)
        await ex.wait()
    finally:
        await rt.remove(box.id, force=True)

    hits = runner_hits_for_box(runner_before, box.id)
    assert hits >= 1, (
        f"no runner journal entries mentioned box_id={box.id}. Either "
        f"the SDK degraded to local FFI, or the API did not forward to "
        f"runner on :8080 (boxlite-runner.service)."
    )
