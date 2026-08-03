"""E2E port of `sdks/python/tests/test_box_management.py`.

Covers create/list/get/remove via the SDK, but in REST mode against
the local API. The source file uses Boxlite.default() (local FFI) —
this version uses Boxlite.rest() so a regression in the proxy
controller surfaces.
"""
from __future__ import annotations

import boxlite
import pytest


@pytest.mark.asyncio
async def test_create_named_box(rt, image):
    """Box created with an explicit name carries it through to
    get_info."""
    name = "e2e-test-box"
    box = await rt.create(
        boxlite.BoxOptions(image=image, auto_remove=True), name=name,
    )
    try:
        info = await rt.get_info(box.id)
        assert info is not None
        assert getattr(info, "name", "") == name, (
            f"name not propagated: got {getattr(info,'name',None)!r}"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_list_info_includes_created_box(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        infos = await rt.list_info()
        ids = {info.id for info in infos}
        assert box.id in ids, f"created box not in list: {ids}"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_box_options_env_propagates_through_rest(rt, image):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image, auto_remove=True,
            env=[("BOXLITE_E2E_MARKER", "yes-its-there")],
        ),
    )
    try:
        # Don't trust serialization round-trip — just exec and check
        # the env var is visible inside the VM. This proves
        # client → API → runner → guest env wiring.
        from conftest import drain
        import asyncio
        ex = await box.exec("sh", ["-c", "echo $BOXLITE_E2E_MARKER"], None)
        out, _ = await drain(ex)
        await asyncio.wait_for(ex.wait(), timeout=30)
        assert "yes-its-there" in out, (
            f"env from BoxOptions did not reach the guest: {out!r}"
        )
    finally:
        await rt.remove(box.id, force=True)
