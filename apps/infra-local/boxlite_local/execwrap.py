"""Single home for the streaming box.exec → final (rc, out, err) collapse.

Per parent design §1.7.B: box.exec returns an Execution with stdout()/stderr()
async iterators and a wait() coroutine. Callers almost always want the final
exit_code + concatenated streams. This helper does exactly that.
"""

from __future__ import annotations

import asyncio


async def exec_collect(
    box,
    command: str,
    args: list[str] | None = None,
    env: list[tuple[str, str]] | None = None,
) -> tuple[int, str, str]:
    """Run `command args` inside `box`, drain streams, return (exit_code, stdout, stderr).

    The SDK exposes `Execution.stdout()` / `stderr()` as async iterators of `str`.
    We drain both concurrently to avoid deadlock on commands producing more
    output than the pipe buffer, then call `wait()` to harvest the exit code
    once the streams are fully consumed.
    """
    execution = await box.exec(command, args or [], env=env)
    out_parts: list[str] = []
    err_parts: list[str] = []

    async def drain(stream, sink: list[str]) -> None:
        async for chunk in stream:
            sink.append(chunk)

    await asyncio.gather(
        drain(execution.stdout(), out_parts),
        drain(execution.stderr(), err_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(out_parts), "".join(err_parts)
