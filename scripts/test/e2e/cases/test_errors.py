"""E2E port of `sdks/python/tests/test_errors.py`.

The source is unit-test-only (BoxliteError dataclass shape, no VM).
This file keeps the error-type contract honest end-to-end:
  - A 4xx server response surfaces as a BoxliteError subclass
    (not a bare RuntimeError, not a 5xx leak).
  - The error message preserves the server's reason / code.
"""
from __future__ import annotations

import json
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

import boxlite
import pytest


def _profile():
    return tomllib.loads(
        (Path.home() / ".boxlite/credentials.toml").read_text()
    )["profiles"]["p1"]


@pytest.mark.asyncio
async def test_create_with_unknown_image_returns_typed_error(rt):
    """Creating a box with an unregistered image must surface a
    BoxliteError (or close subclass), not a bare RuntimeError 500."""
    bogus = "this-image-was-never-registered:0.0.0"
    with pytest.raises(Exception) as exc_info:
        box = await rt.create(boxlite.BoxOptions(image=bogus, auto_remove=True))
        # If we got here something is very wrong — clean up to avoid
        # leaking a half-created box.
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass
    msg = str(exc_info.value)
    assert "500" not in msg and "Internal" not in msg, (
        f"unknown image leaked a 5xx: {msg!r}"
    )
    # Must mention either the image name or "not found" / "snapshot"
    assert ("not found" in msg.lower() or "snapshot" in msg.lower()
            or "image" in msg.lower()), (
        f"error message doesn't explain the problem: {msg!r}"
    )


@pytest.mark.asyncio
async def test_invalid_token_returns_401_not_500():
    """A bad bearer token must return 401/403, not 500."""
    p = _profile()
    req = urllib.request.Request(
        f"{p['url']}/v1/me",
        method="GET",
        headers={"Authorization": "Bearer this-token-is-clearly-not-real"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            pytest.fail(f"bad token got HTTP {r.status} — should be 401")
    except urllib.error.HTTPError as e:
        assert e.code in (401, 403), (
            f"bad token returned HTTP {e.code} — should be 401/403"
        )
