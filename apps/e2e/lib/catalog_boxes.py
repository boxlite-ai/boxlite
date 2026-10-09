"""
Booting boxes against the image catalog, for the cases that watch it change.

Two server behaviours make those cases slow and easy to get wrong: a gate that
refuses cold pulls past a budget, and a runner that reports what an image
resolved to some seconds after the box started. Both are handled here, so a
case reads as its steps.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import TypeVar

import boxlite

T = TypeVar("T")

# The admission gate caps how many cold pulls — creates the catalog cannot
# answer yet — an organization may start per window, and each stack sets its
# own budget. A case makes several, and any other suite on the same
# organization spends from the same budget. Waiting the window out is not a
# workaround for a flaky server: the refusal is the documented contract, it
# carries how long is left, and a suite that treated it as a failure would be
# reporting the gate working as a bug.
WINDOW_REMAINING = re.compile(r"(\d+)s left in the current one")


async def create_box(rt, image: str, *, attempts: int = 3):
    """Create a box, waiting out the cold-pull budget if the gate asks us to."""
    for attempt in range(attempts):
        try:
            return await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
        except Exception as failure:
            remaining = WINDOW_REMAINING.search(str(failure))
            if remaining is None or attempt == attempts - 1:
                raise
            await asyncio.sleep(int(remaining.group(1)) + 1)
    raise AssertionError("unreachable")


# The runner delivers what an image resolved to on its next state push, which
# its box sync makes every 10 seconds, and it drops a report still owed for a
# box that is destroyed first. So the catalog changes only while the box is
# still up, some seconds after it started — and an unchanged catalog proves
# nothing until that window has passed. Two and a half sync periods.
REPORT_WINDOW_SECONDS = 25


async def until_reported(read: Callable[[], Awaitable[T | None]]) -> T | None:
    """What `read` answers, polled until it answers or a report would have landed."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + REPORT_WINDOW_SECONDS
    while True:
        found = await read()
        if found is not None or loop.time() >= deadline:
            return found
        await asyncio.sleep(1)


async def hold_through_report_window(check: Callable[[], Awaitable[None]]) -> None:
    """Assert `check` for as long as a report could still land, failing on the first change."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + REPORT_WINDOW_SECONDS
    while loop.time() < deadline:
        await check()
        await asyncio.sleep(1)
    await check()
