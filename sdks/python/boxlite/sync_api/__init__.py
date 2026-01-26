"""
BoxLite Sync API - Synchronous wrappers using greenlet fiber switching.

This module provides synchronous wrappers for BoxLite's async API using
greenlet fiber switching. This allows sync code to execute async operations
without blocking the event loop.

Architecture:
- A dispatcher fiber runs the asyncio event loop
- User code runs in the main fiber
- _sync() method switches between fibers to execute async operations

Usage:
    from boxlite import SyncCodeBox, SyncSimpleBox

    # Simplest usage - standalone (like async API)
    with SyncCodeBox() as box:
        result = box.run("print('Hello!')")
        print(result)

    with SyncSimpleBox(image="alpine:latest") as box:
        result = box.exec("echo", "Hello")
        print(result.stdout)

    # Or with explicit runtime (for multiple boxes)
    from boxlite import SyncBoxlite

    with SyncBoxlite.default() as runtime:
        box = runtime.create(BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["Hello"])
        for line in execution.stdout():
            print(line)
        box.stop()

Requirements:
    - greenlet>=3.0.0 (install with: pip install boxlite[sync])

Note:
    This API cannot be used from within an async context (e.g., inside
    an async function or when an event loop is already running).
    Use the async API (CodeBox, SimpleBox) in those cases.
"""

from ._boxlite import SyncBoxlite
from ._sync_base import SyncBase, SyncContextManager
from ._box import SyncBox
from ._execution import SyncExecution, SyncExecStdout, SyncExecStderr
from ._simplebox import SyncSimpleBox
from ._codebox import SyncCodeBox
from ._skillbox import SyncSkillBox

__all__ = [
    # Entry point
    "SyncBoxlite",
    # Base classes
    "SyncBase",
    "SyncContextManager",
    # Native API mirrors
    "SyncBox",
    "SyncExecution",
    "SyncExecStdout",
    "SyncExecStderr",
    # Convenience wrappers
    "SyncSimpleBox",
    "SyncCodeBox",
    "SyncSkillBox",
]
