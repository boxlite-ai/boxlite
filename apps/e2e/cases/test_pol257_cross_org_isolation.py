"""POL-257 257-3/257-3a/257-3b — cross-organization isolation.

Org-B, holding only a box id that belongs to Org-A, must be refused on
every operation, and "exists but unauthorized" must be indistinguishable
from "does not exist" (both surface as a same-shaped 404).

Requires a *second* organization's API key. Set BOXLITE_E2E_API_KEY_ORG_B
(and optionally BOXLITE_E2E_URL_ORG_B if it differs from the primary org's
URL) to run this file; it is skipped otherwise rather than failing CI runs
that only provision one tenant.

Manually verified live against api.dev.boxlite.ai on 2026-08-25 (see
POL-257 acceptance report) before this file was written — this pins that
result as a regression test.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import boxlite
import pytest

from e2e_auth import auth_context

ORG_B_KEY = os.environ.get("BOXLITE_E2E_API_KEY_ORG_B")

pytestmark = pytest.mark.skipif(
    not ORG_B_KEY,
    reason="BOXLITE_E2E_API_KEY_ORG_B not set — cross-org isolation needs a second tenant",
)


def _org_b_request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    """Raw REST call authenticated as Org-B against Org-A's box id."""
    ctx = auth_context()  # URL only; Org-B has its own token
    url = os.environ.get("BOXLITE_E2E_URL_ORG_B", ctx.url).rstrip("/") + "/" + path.lstrip("/")
    headers = {"Authorization": f"Bearer {ORG_B_KEY}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        url, method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return exc.code, {"_raw": raw.decode("utf-8", "replace")}


@pytest.fixture
async def org_a_box(rt, image):
    """A box owned by Org-A (the primary `rt` fixture's org) for Org-B to probe."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    yield b
    try:
        await rt.remove(b.id, force=True)
    except Exception:
        pass


@pytest.mark.asyncio
async def test_org_b_read_denied(org_a_box):
    status, _ = _org_b_request("GET", f"/v1/boxes/{org_a_box.id}")
    assert status == 404, f"Org-B read Org-A's box: got {status}, expected 404"


@pytest.mark.asyncio
async def test_org_b_exec_denied(org_a_box):
    status, _ = _org_b_request(
        "POST", f"/v1/boxes/{org_a_box.id}/exec", {"command": "whoami"}
    )
    assert status == 404, f"Org-B exec'd into Org-A's box: got {status}, expected 404"


@pytest.mark.asyncio
async def test_org_b_stop_denied(org_a_box):
    status, _ = _org_b_request("POST", f"/v1/boxes/{org_a_box.id}/stop")
    assert status == 404, f"Org-B stopped Org-A's box: got {status}, expected 404"


@pytest.mark.asyncio
async def test_org_b_delete_denied(org_a_box):
    status, _ = _org_b_request("DELETE", f"/v1/boxes/{org_a_box.id}")
    assert status == 404, f"Org-B deleted Org-A's box: got {status}, expected 404"


@pytest.mark.asyncio
async def test_existence_is_indistinguishable(org_a_box):
    """A real-but-unauthorized id and a random nonexistent id must return
    the identically-shaped 404 — otherwise Org-B can use the response to
    fingerprint which ids are real."""
    real_status, real_body = _org_b_request("GET", f"/v1/boxes/{org_a_box.id}")
    fake_status, fake_body = _org_b_request("GET", "/v1/boxes/ZZZZnotexist00")

    assert real_status == fake_status == 404
    real_shape = {k: type(v).__name__ for k, v in (real_body or {}).items()}
    fake_shape = {k: type(v).__name__ for k, v in (fake_body or {}).items()}
    assert real_shape == fake_shape, (
        f"response shape differs between real-but-unauthorized and nonexistent ids: "
        f"{real_body!r} vs {fake_body!r}"
    )


@pytest.mark.asyncio
async def test_org_b_box_list_excludes_org_a(org_a_box):
    status, body = _org_b_request("GET", "/v1/boxes")
    assert status == 200
    ids = {b["box_id"] for b in (body or {}).get("boxes", [])}
    assert org_a_box.id not in ids, "Org-A's box leaked into Org-B's box list"
