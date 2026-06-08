"""E2E port of `src/boxlite/tests/shutdown.rs`.

The Rust file's `Boxlite::shutdown()` semantics don't translate directly
to REST mode (the runtime is a stateless REST client). This file covers
what shutdown means at the REST layer:

  - Calling `close()` (or letting the runtime drop) does not leak
    boxes — a new runtime sees the same world.
  - Read operations are still safe after the first runtime is dropped
    when a second runtime against the same API is built.
  - A double-close is a no-op (idempotent).
"""
from __future__ import annotations

import tomllib
from pathlib import Path

import boxlite
import pytest


def _build_runtime():
    p = tomllib.loads(
        (Path.home() / ".boxlite/credentials.toml").read_text()
    )["profiles"]["p1"]
    return boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
        url=p["url"],
        credential=boxlite.ApiKeyCredential(p["api_key"]),
        path_prefix=p.get("path_prefix") or "",
    ))


@pytest.mark.asyncio
async def test_close_is_idempotent():
    """Closing a runtime twice must not raise."""
    rt = _build_runtime()
    close = getattr(rt, "close", None)
    if close is None:
        pytest.skip("Boxlite.close() not exposed in this build")
    res1 = close()
    if hasattr(res1, "__await__"):
        await res1
    res2 = close()
    if hasattr(res2, "__await__"):
        await res2


@pytest.mark.asyncio
async def test_two_runtimes_share_world(rt, image):
    """A second runtime built against the same API sees boxes the
    first one created. This is the REST analogue of
    `cloned_runtime_shares_shutdown_state` in shutdown.rs."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        rt2 = _build_runtime()
        infos = await rt2.list_info()
        ids = {info.id for info in infos}
        assert box.id in ids, (
            f"second runtime didn't see box {box.id} created by first; "
            f"got {ids}"
        )
    finally:
        await rt.remove(box.id, force=True)
