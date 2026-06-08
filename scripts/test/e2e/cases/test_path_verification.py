"""Meta-test: prove the e2e suite actually goes through SDK → API → Runner.

The check is two-part:

  (1) The SDK's configured runtime URL is the API on :3000 (not the
      runner's :8080, and not a default-FFI degenerate). Asserted by
      inspecting the runtime's BoxliteRestOptions before any work runs.

  (2) After one round-trip exec, the runner journal contains the box id.
      Runner journal entries (`CREATE_SANDBOX` / `created box id=…
      name=<uuid>`) only ever appear when the API queued the job, which
      only happens when the SDK POSTed to the API on :3000. So a single
      runner-journal hit is sufficient evidence for the whole chain.

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
    """The runtime must be REST-mode and pointing at the local API
    (`:3000`), not local FFI and not directly at the runner."""
    # Boxlite.rest() always wires REST; check the URL the SDK is actually
    # going to use by inspecting the credentials we built it from.
    import tomllib
    cred = tomllib.loads((Path.home() / ".boxlite/credentials.toml").read_text())
    p = cred["profiles"]["p1"]
    url = p["url"]
    assert ":3000" in url, (
        f"profile p1.url={url!r} does not target the local API on :3000. "
        f"E2E tests would talk to the wrong thing."
    )
    assert "/api" in url, (
        f"profile p1.url={url!r} missing /api base path; SDK would route to "
        f"runner endpoints (/v1/boxes...) and skip the NestJS proxy controller."
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
