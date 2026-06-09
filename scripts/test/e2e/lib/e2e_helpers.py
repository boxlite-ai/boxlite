"""Shared async/stream helpers for the e2e pytest suite.

Lifted out of `sdks/python/tests/e2e/conftest.py` so test files can
import them directly. Under `--import-mode=importlib` (set in
pytest.ini to keep `sdks/python/` off sys.path and prevent the
local source-tree `boxlite/` stub from shadowing the installed
wheel), the old `from conftest import drain` pattern doesn't work
because conftest is no longer on sys.path.

Conftest itself adds this `lib/` directory to sys.path via the
same `parents[N]` hop as `path_verification`, so test files just do
`from e2e_helpers import drain, stdout_line_count`.
"""

from __future__ import annotations

import asyncio


async def collect_stream(stream) -> str:
    if stream is None:
        return ""
    chunks: list[str] = []
    async for ch in stream:
        chunks.append(
            ch.decode("utf-8", "replace") if isinstance(ch, bytes) else str(ch)
        )
    return "".join(chunks)


async def drain(ex) -> tuple[str, str]:
    """Drain stdout + stderr concurrently — required for REST exec."""
    out_t = asyncio.create_task(collect_stream(ex.stdout()))
    err_t = asyncio.create_task(collect_stream(ex.stderr()))
    return await asyncio.gather(out_t, err_t)


def stdout_line_count(s: str) -> int:
    return len([ln for ln in s.splitlines() if ln])
