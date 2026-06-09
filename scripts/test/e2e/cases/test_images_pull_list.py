"""E2E port of `src/boxlite/tests/image_registries.rs`.

Verifies the image registry REST surface (runtime.images.pull / list)
against the local API and (for pull) a real OCI registry. The Rust file
covers list/pull/validation at the FFI layer; here we only assert the
parts where the REST proxy + runner-side registry resolution could
diverge:

  - `list` reports any image the fixture pre-registered (the e2e
    bootstrap registers `alpine:3.23`, `ubuntu:22.04`, `ubuntu:24.04`).
  - `pull` against an unreachable registry surfaces a typed client
    error, not a bare 5xx.

We do NOT pull a real new image in this test by default: it adds 20–60s
to the suite, depends on outbound network, and the snapshot-registration
path is already exercised by `fixture_setup.py`. The `pull` smoke is
gated behind `BOXLITE_E2E_RUN_PULL=1` for explicit opt-in.
"""

from __future__ import annotations

import os

import pytest


@pytest.mark.asyncio
async def test_list_reports_fixture_images(rt):
    """`runtime.images.list()` returns ImageInfo entries that include
    the images registered by `scripts/test/e2e/fixture_setup.py`."""
    imgs = await rt.images.list()
    assert imgs is not None, "images.list returned None"
    refs = {i.reference for i in imgs}
    # Bootstrap registers at minimum alpine:3.23; ubuntu:* are nice-to-haves.
    # Don't pin all three because fixture_setup can be re-run with a subset.
    assert any("alpine" in r for r in refs), (
        f"alpine fixture image missing from images.list: {refs}"
    )


@pytest.mark.asyncio
async def test_image_info_fields_populated(rt):
    """Each ImageInfo must have non-empty reference/id and a parseable
    `cached_at` ISO timestamp. Catches DTO-mapping regressions where
    a field gets serialized as the empty string."""
    imgs = await rt.images.list()
    assert imgs, "images.list is empty — fixture_setup didn't run?"
    for info in imgs:
        assert info.reference, f"ImageInfo with empty reference: {info!r}"
        assert info.id, f"ImageInfo with empty id: {info!r}"
        assert info.cached_at, f"ImageInfo with empty cached_at: {info!r}"
        # rfc3339 format always has a 'T' separator between date and time
        assert "T" in info.cached_at, (
            f"cached_at not rfc3339-like: {info.cached_at!r}"
        )


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.environ.get("BOXLITE_E2E_RUN_PULL", "0") != "1",
    reason="pulling from a real registry hits the network — opt-in via BOXLITE_E2E_RUN_PULL=1",
)
async def test_pull_real_image(rt):
    """Pull `alpine:3.19` (not pre-registered by fixture) and verify
    the returned pull-result and that it then shows up in list."""
    target = "alpine:3.19"
    result = await rt.images.pull(target)
    assert result.reference.endswith("alpine:3.19") or result.reference == target, (
        f"pull returned wrong reference: {result.reference!r}"
    )
    assert result.config_digest, "pull returned empty config_digest"
    assert result.layer_count > 0, (
        f"pull reports 0 layers: {result.layer_count}"
    )

    imgs = await rt.images.list()
    refs = {i.reference for i in imgs}
    assert any("3.19" in r for r in refs), (
        f"pulled image not visible in list: {refs}"
    )


@pytest.mark.asyncio
async def test_pull_unreachable_registry_is_typed_error(rt):
    """An obviously-bad registry URL must surface as a client-side
    error (not a 5xx). This is the same contract `test_errors.py`
    enforces for box creation — repeated here to keep image pull
    independently regression-protected."""
    # Avoid `:5000` in the URL — the substring guard below would false-
    # positive on the port number.
    bogus = "does-not-exist.invalid.boxlite-e2e.local/nope:0.0.0"
    with pytest.raises(Exception) as exc_info:
        await rt.images.pull(bogus)
    msg = str(exc_info.value)
    # Strip the echoed URL before checking — the message embeds the
    # caller's reference and any digit run there would false-positive.
    msg_for_check = msg.replace(bogus, "<bogus>")
    assert "500" not in msg_for_check and "Internal" not in msg_for_check, (
        f"unreachable registry leaked a 5xx: {msg!r}"
    )
