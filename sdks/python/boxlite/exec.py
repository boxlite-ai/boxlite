"""
Execution API - Simple interface for command execution.

Provides Docker-like API for executing commands in boxes.
"""

import asyncio
from dataclasses import dataclass
from logging import Logger
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .boxlite import Execution

# Allow two seconds for Guest SIGTERM cleanup and another second for delivery.
_EXEC_COMPLETION_GRACE_SECONDS = 3.0

__all__ = [
    "ExecResult",
]


@dataclass
class ExecResult:
    """
    Result from a command execution.

    Attributes:
        exit_code: Exit code from the command (negative if terminated by signal)
        stdout: Standard output as string
        stderr: Standard error as string
        error_message: Diagnostic message when process died unexpectedly
            (e.g., container init death). None if normal exit.
    """

    exit_code: int
    stdout: str
    stderr: str
    error_message: str | None = None


async def _collect_exec_result(
    execution: "Execution", timeout: float | None, logger: Logger
) -> ExecResult:
    """Drain both streams while bounding completion for timed commands."""
    stdout_lines = []
    stderr_lines = []

    async def collect(stream_name: str, lines: list[str]) -> None:
        try:
            stream = getattr(execution, stream_name)()
        except Exception as e:  # noqa: BLE001 - native stream may be unavailable
            logger.error(f"take {stream_name} err: {e}")
            return
        if stream is None:
            return
        try:
            async for line in stream:
                lines.append(
                    line.decode("utf-8", errors="replace")
                    if isinstance(line, bytes)
                    else line
                )
        except Exception as e:  # noqa: BLE001 - preserve partial output
            logger.error(f"collecting {stream_name} err: {e}")

    async def wait_for_status():
        try:
            return await execution.wait()
        except Exception as e:  # noqa: BLE001 - native binding failure maps to exit code -1
            logger.error(f"failed to wait execution: {e}")
            return None

    output = asyncio.gather(
        collect("stdout", stdout_lines), collect("stderr", stderr_lines)
    )
    completion_error = None
    if timeout is None or timeout == 0:
        await output
        exec_result = await wait_for_status()
    else:
        status = asyncio.create_task(wait_for_status())
        tasks = (output, status)
        try:
            _, pending = await asyncio.wait(
                tasks, timeout=float(timeout) + _EXEC_COMPLETION_GRACE_SECONDS
            )
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        if status in pending:
            exec_result = None
            completion_error = "Timed out waiting for the command result"
        else:
            exec_result = status.result()
            if output in pending:
                completion_error = "Timed out collecting command output"

    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    exit_code = exec_result.exit_code if exec_result is not None else -1
    error_message = exec_result.error_message if exec_result is not None else None
    if completion_error:
        error_message = (
            f"{error_message}\n{completion_error}"
            if error_message
            else completion_error
        )

    logger.debug(f"exec finish, exit_code: {exit_code}")

    return ExecResult(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        error_message=error_message,
    )
