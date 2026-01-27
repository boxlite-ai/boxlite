"""
BrowserBox - Secure browser with Playwright Server.

Provides a minimal, elegant API for running isolated browsers that can be
controlled from outside using Playwright. Supports all browser types:
chromium, firefox, and webkit.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING, Any

from . import constants as const
from .simplebox import SimpleBox

if TYPE_CHECKING:
    from .boxlite import Boxlite

__all__ = ["BrowserBox", "BrowserBoxOptions"]


@dataclass
class BrowserBoxOptions:
    """
    Configuration for BrowserBox.

    Example:
        >>> opts = BrowserBoxOptions(
        ...     browser="chromium",
        ...     memory=2048,
        ...     cpu=2
        ... )
        >>> async with BrowserBox(opts) as browser:
        ...     endpoint = await browser.ws_endpoint()
        ...     print(endpoint)
    """

    browser: str = "chromium"  # chromium, firefox, or webkit
    memory: int = 2048  # Memory in MiB
    cpu: int = 2  # Number of CPU cores
    port: Optional[int] = None  # Host port for WebSocket (default: 3000)


class BrowserBox(SimpleBox):
    """
    Secure browser environment with Playwright Server.

    Auto-starts a browser with Playwright Server enabled for remote control.
    Connect from outside using Playwright's `connect()` method.

    Usage:
        >>> async with BrowserBox() as browser:
        ...     ws = await browser.ws_endpoint()
        ...     print(f"Connect to: {ws}")
        ...     # Use Playwright from your host to connect
        ...     await asyncio.sleep(60)

    Example with Playwright:
        >>> from playwright.async_api import async_playwright
        >>> async with BrowserBox() as browser:
        ...     ws = await browser.ws_endpoint()
        ...     async with async_playwright() as p:
        ...         b = await p.chromium.connect(ws)
        ...         page = await b.new_page()
        ...         await page.goto("https://example.com")
    """

    # Playwright Docker image with all browsers pre-installed
    _DEFAULT_IMAGE = "mcr.microsoft.com/playwright:v1.58.0-jammy"

    # Playwright version - must match the Docker image
    _PLAYWRIGHT_VERSION = "1.58.0"

    # Default port for Playwright Server (single port for all browsers)
    _DEFAULT_PORT = const.BROWSERBOX_PORT

    def __init__(
        self,
        options: Optional[BrowserBoxOptions] = None,
        runtime: Optional["Boxlite"] = None,
        **kwargs,
    ):
        """
        Create a BrowserBox instance.

        Args:
            options: Browser configuration (uses defaults if None)
            runtime: Optional runtime instance (uses global default if None)
            **kwargs: Additional configuration options (volumes, env, ports, etc.)
        """
        opts = options or BrowserBoxOptions()

        self._browser = opts.browser
        # Guest port: where Playwright Server listens inside VM (fixed)
        self._guest_port = self._DEFAULT_PORT
        # Host port: what host connects to (user-configurable)
        self._host_port = opts.port or self._guest_port
        # Track if server has been started
        self._started = False

        # Extract user ports and add port forwarding
        user_ports = kwargs.pop("ports", [])
        default_ports = [(self._host_port, self._guest_port)]

        # Initialize base box with port forwarding
        super().__init__(
            image=self._DEFAULT_IMAGE,
            memory_mib=opts.memory,
            cpus=opts.cpu,
            runtime=runtime,
            ports=default_ports + list(user_ports),
            **kwargs,
        )

    async def __aenter__(self):
        """Start the box but don't auto-start browser (lazy start via ws_endpoint)."""
        await super().__aenter__()
        # Don't auto-start browser here - let ws_endpoint() handle it
        return self

    async def _start_browser(self, timeout: int = 60):
        """
        Start Playwright Server (works for all browser types).

        The server binds to 0.0.0.0, so no proxy is needed.
        Browser type is specified by the client when connecting, not the server.

        Args:
            timeout: Maximum time to wait for server to start in seconds

        Raises:
            TimeoutError: If server doesn't start within timeout
        """
        cmd = (
            f"npx -y playwright@{self._PLAYWRIGHT_VERSION} run-server "
            f"--port {self._guest_port} --host 0.0.0.0 "
            f"> /tmp/playwright.log 2>&1 &"
        )
        await self.run("sh", "-c", f"nohup {cmd}")
        await self._wait_for_server(timeout)
        self._started = True

    async def _wait_for_server(self, timeout: int):
        """
        Poll until Playwright Server is ready.

        Args:
            timeout: Maximum wait time in seconds

        Raises:
            TimeoutError: If server doesn't become ready within timeout
        """
        start = time.time()
        poll_interval = 0.5

        while time.time() - start < timeout:
            # Check if server is responding on the external interface
            check = (
                f"curl -sf http://{const.GUEST_IP}:{self._guest_port}/json "
                f"> /dev/null 2>&1 && echo ready || echo notready"
            )
            result = await self.run("sh", "-c", check)
            if result.stdout.strip() == "ready":
                return
            await asyncio.sleep(poll_interval)

        # Try to get log output for debugging
        log_content = ""
        try:
            log_result = await self.run(
                "sh", "-c", "cat /tmp/playwright.log 2>/dev/null || echo 'No log'"
            )
            log_content = log_result.stdout.strip()
        except Exception:
            pass

        raise TimeoutError(
            f"Playwright Server ({self._browser}) did not start within {timeout}s. "
            f"Log: {log_content[:500]}"
        )

    async def ws_endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for Playwright connect().

        This is the primary method to get the connection URL.
        The returned URL can be used with Playwright's `connect()` method.
        Auto-starts the Playwright Server if not already started.

        Args:
            timeout: Maximum time to wait for server to start (if needed)

        Returns:
            WebSocket endpoint URL (e.g., 'ws://localhost:3000/')

        Example:
            >>> async with BrowserBox() as browser:
            ...     ws = await browser.ws_endpoint()
            ...     # Use with Playwright:
            ...     # browser = await chromium.connect(ws)
        """
        if not self._started:
            await self._start_browser(timeout)
        return f"ws://localhost:{self._host_port}/"

    async def connect(self, timeout: int = 60) -> Any:
        """
        Connect to the browser using Playwright.

        Convenience method that returns a connected Playwright Browser instance.
        Requires playwright to be installed.

        Args:
            timeout: Maximum time to wait for server to start

        Returns:
            Connected Playwright Browser instance

        Example:
            >>> async with BrowserBox(BrowserBoxOptions(browser="webkit")) as box:
            ...     browser = await box.connect()
            ...     page = await browser.new_page()
            ...     await page.goto("https://example.com")
        """
        ws = await self.ws_endpoint(timeout)

        # Dynamic import to avoid requiring playwright as a dependency
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ImportError(
                "playwright is required for connect(). "
                "Install with: pip install playwright"
            )

        pw = await async_playwright().start()
        browser_type = getattr(pw, self._browser, None)

        if browser_type is None:
            raise ValueError(f"Unknown browser type: {self._browser}")

        return await browser_type.connect(ws)

    @property
    def browser(self) -> str:
        """Get the browser type ('chromium', 'firefox', or 'webkit')."""
        return self._browser
