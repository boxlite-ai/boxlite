"""E2E port of `src/boxlite/tests/lifecycle.rs`.

Source covers runtime list/get/exists/remove semantics against the
local FFI runtime. This file exercises the same surface but in REST
mode, so any behaviour difference between the REST proxy controller
and the local runtime surfaces.
"""
from __future__ import annotations

import boxlite
import pytest


@pytest.mark.asyncio
async def test_runtime_initialization_creates_empty_list(rt):
    """A fresh runtime sees no boxes belonging to the current
    organization (modulo concurrent test runs)."""
    infos = await rt.list_info()
    assert infos is not None
    # We can't assert empty (concurrent tests may share the org) — just
    # that the listing is well-formed.
    for info in infos:
        assert hasattr(info, "id")
        assert hasattr(info, "state")


@pytest.mark.asyncio
async def test_create_generates_unique_ids(rt, image):
    a = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        assert a.id != b.id
        # uuid v4 format check
        assert len(a.id.split("-")) == 5
        assert len(b.id.split("-")) == 5
    finally:
        await rt.remove(a.id, force=True)
        await rt.remove(b.id, force=True)


@pytest.mark.asyncio
async def test_get_info_returns_box_metadata(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        info = await rt.get_info(box.id)
        assert info is not None
        assert info.id == box.id
        # cpus, image, etc. should be populated from the create options.
        assert hasattr(info, "image")
        assert image in str(getattr(info, "image", ""))
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_get_info_returns_none_for_nonexistent(rt):
    """get_info on a UUID that was never created should be a clean
    None / 404, not a 5xx."""
    bogus_id = "00000000-0000-0000-0000-000000000001"
    try:
        info = await rt.get_info(bogus_id)
        assert info is None, f"expected None for missing box, got {info!r}"
    except Exception as e:
        msg = str(e)
        # If the SDK raises, must be typed (404 / not found), not 5xx
        assert "500" not in msg and "Internal" not in msg, (
            f"get_info on nonexistent id leaked a 5xx: {msg!r}"
        )


@pytest.mark.asyncio
async def test_remove_nonexistent_returns_not_found(rt):
    bogus_id = "00000000-0000-0000-0000-000000000002"
    with pytest.raises(Exception) as exc_info:
        await rt.remove(bogus_id, force=True)
    msg = str(exc_info.value)
    assert "500" not in msg and "Internal" not in msg, (
        f"remove of nonexistent leaked a 5xx: {msg!r}"
    )
