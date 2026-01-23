"""
Base class for sync wrappers - provides _sync() method.

This module contains the core bridging logic that allows sync code to
execute async operations using greenlet fiber switching.
"""

import asyncio
import inspect
import traceback
from typing import Any, Awaitable, Coroutine, TypeVar, Union

from greenlet import greenlet

__all__ = ["SyncBase", "SyncContextManager"]

T = TypeVar("T")


class SyncBase:
    """
    Base class for all sync wrapper objects.

    Provides the _sync() method that bridges async to sync using greenlet
    fiber switching. This is the core mechanism that allows synchronous
    code to execute asynchronous operations.

    How it works:
        1. User calls a sync method (e.g., box.run_command())
        2. Sync method calls _sync(async_coro)
        3. _sync() creates an asyncio task and switches to dispatcher fiber
        4. Dispatcher fiber runs event loop, processes the task
        5. When task completes, callback switches back to user fiber
        6. _sync() returns the task result
    """

    def __init__(
        self,
        impl_obj: Any,
        loop: asyncio.AbstractEventLoop,
        dispatcher_fiber: greenlet,
    ) -> None:
        """
        Initialize SyncBase.

        Args:
            impl_obj: The underlying async implementation object
            loop: The asyncio event loop (managed by dispatcher)
            dispatcher_fiber: The greenlet fiber running the event loop
        """
        self._impl = impl_obj
        self._loop = loop
        self._dispatcher_fiber = dispatcher_fiber

    def _sync(
        self,
        coro: Union[Coroutine[Any, Any, T], Awaitable[T]],
    ) -> T:
        """
        Run async coroutine synchronously using greenlet fiber switching.

        This is the core bridging method that enables sync-to-async conversion.

        The method:
        1. Creates an asyncio task from the coroutine
        2. Registers a callback to switch back when task completes
        3. Switches to dispatcher fiber to let event loop run
        4. Returns the task result (or raises exception)

        Args:
            coro: The async coroutine to execute

        Returns:
            The result of the coroutine

        Raises:
            RuntimeError: If event loop is closed
            Any exception raised by the coroutine
        """
        __tracebackhide__ = True  # Hide from pytest tracebacks

        # Guard: event loop must be open
        if self._loop.is_closed():
            if hasattr(coro, "close"):
                coro.close()
            raise RuntimeError("Event loop is closed! Is BoxLite stopped?")

        # 1. Get current fiber (user fiber)
        g_self = greenlet.getcurrent()

        # 2. Create async task from coroutine/future
        # Note: PyO3's async methods return Future objects (not native coroutines),
        # so we use ensure_future() which handles both coroutines and futures.
        task: asyncio.Task = asyncio.ensure_future(coro, loop=self._loop)

        # 3. Attach debug info for better stack traces
        setattr(task, "__boxlite_stack__", inspect.stack(0))
        setattr(task, "__boxlite_stack_trace__", traceback.extract_stack(limit=10))

        # 4. When task completes, switch back to us
        task.add_done_callback(lambda _: g_self.switch())

        # 5. THE CORE LOOP: Keep switching to dispatcher until done
        while not task.done():
            self._dispatcher_fiber.switch()
            # ^^^^^ Control goes to dispatcher fiber
            # Dispatcher runs event loop, processes our task
            # When task completes, callback fires g_self.switch()
            # Control returns HERE

        # 6. Return result (or raise exception)
        return task.result()


class SyncContextManager(SyncBase):
    """
    SyncBase with context manager support.

    Provides __enter__ and __exit__ methods for use with 'with' statement.
    Subclasses should override close() for cleanup logic.
    """

    def __enter__(self) -> "SyncContextManager":
        """Enter context manager."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit context manager - calls close()."""
        self.close()

    def close(self) -> None:
        """
        Close and cleanup resources.

        Override in subclasses to implement cleanup logic.
        """
        pass
