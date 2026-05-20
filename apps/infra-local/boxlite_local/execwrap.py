"""Single home for the streaming box.exec → final (rc, out, err) collapse.

Per parent design §1.7.B: box.exec returns an Execution with stdout()/stderr()
async iterators and a wait() coroutine. Callers almost always want the final
exit_code + concatenated streams. This helper does exactly that.
"""

from __future__ import annotations

import asyncio
from typing import Optional


async def exec_collect(
    box,
    command: str,
    args: Optional[list[str]] = None,
    env: Optional[list[tuple[str, str]]] = None,
) -> tuple[int, str, str]:
    """Run `command args` inside `box`, drain streams, return (exit_code, stdout, stderr)."""
    execution = await box.exec(command, args or [], env=env)
    out_parts: list[str] = []
    err_parts: list[str] = []

    async def drain(stream, sink: list[str]) -> None:
        async for chunk in stream:
            sink.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    await asyncio.gather(
        drain(execution.stdout(), out_parts),
        drain(execution.stderr(), err_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(out_parts), "".join(err_parts)
