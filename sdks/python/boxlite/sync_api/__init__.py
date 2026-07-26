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

from ._box import SyncBox
from ._boxlite import SyncBoxlite
from ._codebox import SyncCodeBox
from ._execution import SyncExecStderr, SyncExecStdout, SyncExecution
from ._images import SyncImageHandle
from ._network import SyncNetworkHandle
from ._simplebox import SyncSimpleBox
from ._skillbox import SyncSkillBox
from ._ssh_certificates import SyncSshCertificateHandle
from ._sync_base import SyncBase, SyncContextManager

__all__ = [  # noqa: RUF022 - grouped by API area, not alphabetical
    # Entry point
    "SyncBoxlite",
    # Base classes
    "SyncBase",
    "SyncContextManager",
    # Native API mirrors
    "SyncBox",
    "SyncImageHandle",
    "SyncNetworkHandle",
    "SyncSshCertificateHandle",
    "SyncExecution",
    "SyncExecStdout",
    "SyncExecStderr",
    # Convenience wrappers
    "SyncSimpleBox",
    "SyncCodeBox",
    "SyncSkillBox",
]
