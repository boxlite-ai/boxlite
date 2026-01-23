"""
SyncBoxlite - Synchronous wrapper for Boxlite runtime.

Provides sync API using greenlet fiber switching. This is the main entry point
for the synchronous BoxLite API.
"""

import asyncio
from typing import TYPE_CHECKING, List, Optional

from greenlet import greenlet

if TYPE_CHECKING:
    from ._box import SyncBox
    from ..boxlite import Boxlite, BoxOptions, BoxInfo, RuntimeMetrics, Options

__all__ = ["SyncBoxlite"]


class SyncBoxlite:
    """
    Synchronous wrapper for Boxlite runtime.

    This class handles both the dispatcher fiber lifecycle AND provides the
    runtime API. API mirrors async Boxlite exactly.

    Usage (default runtime - preferred):
        with SyncBoxlite.default() as runtime:
            box = runtime.create(BoxOptions(image="alpine:latest"))
            execution = box.exec("echo", ["Hello"])
            for line in execution.stdout():
                print(line)
            box.stop()

    Usage (with custom options):
        with SyncBoxlite(Options(home_dir="/custom/path")) as runtime:
            box = runtime.create(BoxOptions(image="alpine:latest"))
            # Data stored in /custom/path instead of ~/.boxlite
            box.stop()

    Usage (manual start/stop - for REPL, test fixtures):
        runtime = SyncBoxlite.default().start()
        box = runtime.create(BoxOptions(image="alpine:latest"))
        # ... use box ...
        runtime.stop()

    Architecture:
        - Creates a dispatcher greenlet fiber that runs the event loop
        - User code runs in the main fiber
        - When user calls a sync method, it switches to dispatcher
        - Dispatcher processes the async task
        - When task completes, callback switches back to user fiber
    """

    def __init__(self, options: "Options") -> None:
        """Create a new SyncBoxlite instance.

        Args:
            options: Runtime options (e.g., custom home_dir).
                     Use SyncBoxlite.default() for default runtime.
        """
        from ..boxlite import Boxlite

        self._boxlite = Boxlite(options)

        self._loop: asyncio.AbstractEventLoop = None
        self._dispatcher_fiber: greenlet = None
        self._own_loop = False
        self._sync_helper = None
        self._started = False

    def __enter__(self) -> "SyncBoxlite":
        """
        Start the sync runtime and enter context.

        Returns:
            Self, with dispatcher fiber running and runtime ready.

        Raises:
            RuntimeError: If called from within an async context.
        """
        # 1. Create event loop
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = asyncio.new_event_loop()
            self._own_loop = True

        # 2. Check not in async context (loop shouldn't be running)
        if self._loop.is_running():
            raise RuntimeError(
                "Cannot use SyncBoxlite inside an asyncio loop. "
                "Use the async API (CodeBox, SimpleBox) instead."
            )

        # 3. Create dispatcher fiber
        def greenlet_main() -> None:
            """
            Dispatcher fiber entry point.

            Runs the event loop indefinitely until stop() is called.
            The event loop efficiently waits for I/O events (via OS-level
            epoll/kqueue) and processes tasks scheduled by _sync() calls.
            """
            self._loop.run_forever()

        self._dispatcher_fiber = greenlet(greenlet_main)

        from ._sync_base import SyncBase

        self._sync_helper = SyncBase(self._boxlite, self._loop, self._dispatcher_fiber)

        # 5. Start dispatcher fiber
        g_self = greenlet.getcurrent()

        def on_ready():
            """Callback to switch back to user fiber after dispatcher starts."""
            g_self.switch()

        self._loop.call_soon(on_ready)
        self._dispatcher_fiber.switch()
        # Control returns here after dispatcher calls on_ready()

        self._started = True
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """
        Stop the sync runtime and clean up.

        This stops the dispatcher fiber and closes the event loop if we own it.
        """
        self._started = False

        # Signal the event loop to stop, then switch to let it finish cleanly
        self._loop.call_soon(self._loop.stop)
        self._dispatcher_fiber.switch()

        if self._own_loop:
            # Cancel pending tasks
            try:
                tasks = asyncio.all_tasks(self._loop)
                for t in [t for t in tasks if not (t.done() or t.cancelled())]:
                    t.cancel()
                self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            except Exception:
                pass  # Ignore errors during cleanup
            finally:
                self._loop.close()

    def start(self) -> "SyncBoxlite":
        """
        Start the sync runtime (non-context-manager usage).

        This is an alternative to using `with SyncBoxlite.default() as runtime:`.
        Useful for REPL sessions, test fixtures, or class-based lifecycle.

        Returns:
            Self, with dispatcher fiber running and runtime ready.

        Example:
            runtime = SyncBoxlite.default().start()
            box = runtime.create(BoxOptions(image="alpine:latest"))
            # ... use box ...
            runtime.stop()  # Don't forget to stop!
        """
        return self.__enter__()

    def stop(self) -> None:
        """
        Stop the sync runtime (non-context-manager usage).

        This cleans up the dispatcher fiber and event loop.
        Must be called if you used start() instead of the context manager.

        Example:
            runtime = SyncBoxlite.default().start()
            try:
                box = runtime.create(BoxOptions(image="alpine:latest"))
                # ... use box ...
            finally:
                runtime.stop()
        """
        self.__exit__(None, None, None)

    @staticmethod
    def init_default(options: "Options") -> None:
        """
        Initialize the global default runtime with custom options.

        This must be called before any SyncBoxlite.default() usage if you want
        to customize the default runtime (e.g., custom home_dir).

        Args:
            options: Runtime options to use for the default runtime.

        Example:
            SyncBoxlite.init_default(Options(home_dir="/custom/path"))
            with SyncBoxlite.default() as runtime:  # Now uses /custom/path
                ...
        """
        from ..boxlite import Boxlite

        Boxlite.init_default(options)

    @staticmethod
    def default() -> "SyncBoxlite":
        """
        Create a SyncBoxlite with default runtime options.

        This is the recommended way to create a SyncBoxlite instance.
        Mirrors async Boxlite.default().

        Returns:
            A new SyncBoxlite instance using the default runtime (~/.boxlite).

        Example:
            with SyncBoxlite.default() as runtime:
                box = runtime.create(BoxOptions(image="alpine:latest"))
                ...
        """
        instance = object.__new__(SyncBoxlite)

        from ..boxlite import Boxlite

        instance._boxlite = Boxlite.default()

        instance._loop = None
        instance._dispatcher_fiber = None
        instance._own_loop = False
        instance._sync_helper = None
        instance._started = False

        return instance

    def _require_started(self) -> None:
        """Raise RuntimeError if runtime not started."""
        if not self._started:
            raise RuntimeError(
                "SyncBoxlite not started. Use 'with SyncBoxlite(...) as runtime:' "
                "or call 'SyncBoxlite.start()' first."
            )

    def _sync(self, coro):
        """Run async operation synchronously."""
        self._require_started()
        return self._sync_helper._sync(coro)

    # ─────────────────────────────────────────────────────────────────────────
    # Runtime API (mirrors Boxlite)
    # ─────────────────────────────────────────────────────────────────────────

    def create(
        self,
        options: "BoxOptions",
        name: Optional[str] = None,
    ) -> "SyncBox":
        """
        Create a new box.

        Args:
            options: BoxOptions specifying image, resources, etc.
            name: Optional unique name for the box.

        Returns:
            SyncBox handle for the created box.

        Example:
            with SyncBoxlite.default() as runtime:
                box = runtime.create(BoxOptions(image="alpine:latest"))
        """
        self._require_started()
        from ._box import SyncBox

        native_box = self._sync(self._boxlite.create(options, name=name))
        return SyncBox(self, native_box)

    def get(self, id_or_name: str) -> Optional["SyncBox"]:
        """
        Get an existing box by ID or name.

        Args:
            id_or_name: Box ID or name to look up.

        Returns:
            SyncBox if found, None otherwise.
        """
        self._require_started()
        from ._box import SyncBox

        native_box = self._sync(self._boxlite.get(id_or_name))
        if native_box is None:
            return None
        return SyncBox(self, native_box)

    def list_info(self) -> List["BoxInfo"]:
        """
        List all boxes.

        Returns:
            List of BoxInfo for all boxes.
        """
        self._require_started()
        return self._sync(self._boxlite.list_info())

    def get_info(self, id_or_name: str) -> Optional["BoxInfo"]:
        """
        Get info for a box by ID or name.

        Args:
            id_or_name: Box ID or name to look up.

        Returns:
            BoxInfo if found, None otherwise.
        """
        self._require_started()
        return self._sync(self._boxlite.get_info(id_or_name))

    def metrics(self) -> "RuntimeMetrics":
        """
        Get runtime metrics.

        Returns:
            RuntimeMetrics with aggregate statistics.
        """
        self._require_started()
        return self._sync(self._boxlite.metrics())

    def remove(self, id_or_name: str, force: bool = False) -> None:
        """
        Remove a box.

        Args:
            id_or_name: Box ID or name to remove.
            force: Force removal even if box is running.
        """
        self._sync(self._boxlite.remove(id_or_name, force))

    def shutdown(self, timeout: Optional[int] = None) -> None:
        """
        Gracefully shutdown all boxes in this runtime.

        This method stops all running boxes, waiting up to `timeout` seconds
        for each box to stop gracefully before force-killing it.

        After calling this method, the runtime is permanently shut down and
        will return errors for any new operations (like `create()`).

        Args:
            timeout: Seconds to wait before force-killing each box:
                - None (default) - Use default timeout (10 seconds)
                - Positive integer - Wait that many seconds
                - -1 - Wait indefinitely (no timeout)
        """
        self._sync(self._boxlite.shutdown(timeout))

    # ─────────────────────────────────────────────────────────────────────────
    # Properties for internal use by SyncBox/SyncExecution
    # ─────────────────────────────────────────────────────────────────────────

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        """Get the event loop used by this runtime."""
        return self._loop

    @property
    def dispatcher_fiber(self) -> greenlet:
        """Get the dispatcher greenlet fiber."""
        return self._dispatcher_fiber

    @property
    def runtime(self) -> "Boxlite":
        """Get the underlying native Boxlite runtime (for internal/advanced use)."""
        return self._boxlite

    def __repr__(self) -> str:
        return f"SyncBoxlite({self._boxlite})"
