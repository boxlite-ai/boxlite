"""POL-257 257-12/257-13, POL-303, POL-332 — secrets over the REST path.

`BoxOptions(secrets=[Secret(...)])` is BoxLite's flagship "the real value
never enters the box" mechanism. Over local FFI it works (see
sdks/python/tests/test_secret_substitution.py); over the REST path used by
Cloud it is currently a no-op end to end: no placeholder is injected, no
real value leaks either — the secret vanishes silently.

Manually verified live against api.dev.boxlite.ai on 2026-08-24 (see POL-257
acceptance report / POL-303 / POL-332). These tests pin that as a known
regression via xfail(strict=True): if the mechanism gets wired up, the test
starts passing and pytest fails the xfail, forcing someone to notice and
remove the marker rather than have the fix go unnoticed.
"""
from __future__ import annotations

import uuid

import boxlite
import pytest

from e2e_auth import request_json


def _canary() -> str:
    return f"sk-CANARY-{uuid.uuid4().hex}"


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-332: Secret.placeholder returns None even though repr() "
    "shows the placeholder was generated correctly.",
)
async def test_secret_placeholder_attribute_matches_repr():
    """POL-332: Secret.placeholder must return the same value shown in
    repr(), not None."""
    secret = boxlite.Secret("LLM_KEY", _canary())
    repr_str = repr(secret)
    assert "<BOXLITE_SECRET:LLM_KEY>" in repr_str, f"unexpected repr: {repr_str!r}"
    assert secret.placeholder == "<BOXLITE_SECRET:LLM_KEY>", (
        f"Secret.placeholder is {secret.placeholder!r} but repr() shows the "
        f"placeholder was generated: {repr_str!r}"
    )


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="POL-303: secrets= is a no-op over the REST path — no placeholder "
    "env var is injected into the box. Local FFI path works; see "
    "sdks/python/tests/test_secret_substitution.py.",
)
async def test_secret_placeholder_env_injected_via_rest(rt, image):
    canary = _canary()
    secret = boxlite.Secret("LLM_KEY", canary)
    box = await rt.create(boxlite.BoxOptions(image=image, secrets=[secret], auto_remove=True))
    try:
        ex = await box.exec("printenv")
        out = b"".join(
            [c if isinstance(c, bytes) else c.encode() async for c in ex.stdout()]
        ).decode(errors="replace")
        await ex.wait()

        assert canary not in out, "real secret value leaked into box env"
        assert "BOXLITE_SECRET" in out, (
            "no BOXLITE_SECRET_* placeholder env var found — secrets= was silently dropped"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_secret_real_value_never_reaches_box_env(rt, image):
    """Even with the mechanism broken, the one property that must never
    regress: the real canary value must never appear inside the box,
    whether as plaintext or otherwise. This is NOT xfail — a leak here
    would be strictly worse than today's silent-drop behavior."""
    canary = _canary()
    secret = boxlite.Secret("LLM_KEY", canary)
    box = await rt.create(boxlite.BoxOptions(image=image, secrets=[secret], auto_remove=True))
    try:
        ex = await box.exec("printenv")
        out = b"".join(
            [c if isinstance(c, bytes) else c.encode() async for c in ex.stdout()]
        ).decode(errors="replace")
        await ex.wait()
        assert canary not in out, "CRITICAL: real secret value leaked into box env"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_secret_real_value_never_echoed_in_box_read(rt, image):
    """The internal GET /box/{id} path returns a raw `env` map. Even
    though secrets= does nothing today, confirm the create-time plaintext
    canary never round-trips back out through a read endpoint (POL-257
    problem 2's failure mode, generalized to the secrets path)."""
    canary = _canary()
    secret = boxlite.Secret("LLM_KEY", canary)
    box = await rt.create(boxlite.BoxOptions(image=image, secrets=[secret], auto_remove=True))
    try:
        status, body = request_json("GET", f"/box/{box.id}")
        assert status == 200
        assert canary not in str(body), f"canary echoed back in box read: {body!r}"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_env_plaintext_is_echoed_by_internal_box_read(rt, image):
    """POL-257 problem 2, the `env=` (plaintext) path: this is documented
    *current* behavior, not a bug under test here — env= is explicitly the
    unsafe/plaintext injection path. This test exists so a future change
    to that contract (e.g. redacting env in reads) is a deliberate,
    visible decision instead of a silent behavior change."""
    canary = _canary()
    box = await rt.create(
        boxlite.BoxOptions(image=image, env=[("LLM_KEY", canary)], auto_remove=True)
    )
    try:
        status, body = request_json("GET", f"/box/{box.id}")
        assert status == 200
        assert body.get("env", {}).get("LLM_KEY") == canary, (
            "env= plaintext no longer echoed by GET /box/{id} — if this is "
            "intentional, update this test's docstring and assertion"
        )
    finally:
        await rt.remove(box.id, force=True)
