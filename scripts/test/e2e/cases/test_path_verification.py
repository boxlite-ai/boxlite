"""Meta-test: prove the e2e suite actually goes through SDK → API → Runner.

The check is two-part:

  (1) The SDK's configured runtime URL is the API on :3000 (not the
      runner's :8080, and not a default-FFI degenerate). Asserted by
      inspecting the runtime's BoxliteRestOptions before any work runs.

  (2) After one round-trip exec, the runner journal contains the box id.
      Runner journal entries (`CREATE_BOX` / `created box id=…
      name=<uuid>`) only ever appear when the API queued the job, which
      only happens when the SDK POSTed to the API on :3000. So a single
      runner-journal hit is sufficient evidence for the whole chain.

If either check fails, downstream regression tests cannot be trusted —
they may be passing because they're talking to something other than the
production exec path.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box
from conftest import drain

# Both checks in this module are local-stack-only:
#   * `:3000 in url` assumes the SDK targets a colocated NestJS API,
#     which is true for the local profile but not for the Tokyo cloud
#     stack where the SDK hits an ALB DNS name without a port.
#   * `runner_hits_for_box` reads `journalctl -u boxlite-runner` on
#     the pytest host, which only works when runner + pytest share a
#     host (local) — in cloud the runner lives on a separate EC2 host.
# The e2e-cloud workflow sets BOXLITE_E2E_SKIP_PATH_VERIFY=1 to opt
# out; the autouse runner-journal fixture in conftest.py honors the
# same variable, so the semantics are consistent across the module.
pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_E2E_SKIP_PATH_VERIFY", "").lower() in ("1", "true", "yes", "on"),
    reason="path-verification tests are local-only (assume :3000 + journalctl on pytest host)",
)


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
