"""
BrowserBox - Secure browser with remote debugging.

Provides a minimal, elegant API for running isolated browsers that can be
controlled from outside using standard tools like Puppeteer or Playwright.
"""

from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

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
        ...     print(browser.endpoint())
    """

    browser: str = "chromium"  # chromium, firefox, or webkit
    memory: int = 2048  # Memory in MiB
    cpu: int = 2  # Number of CPU cores


class BrowserBox(SimpleBox):
    """
    Secure browser environment with remote debugging.

    Auto-starts a browser with Chrome DevTools Protocol enabled.
    Connect from outside using Puppeteer, Playwright, Selenium, or DevTools.

    Usage:
        >>> async with BrowserBox() as browser:
        ...     print(f"Connect to: {browser.endpoint()}")
        ...     # Use Puppeteer/Playwright from your host to connect
        ...     await asyncio.sleep(60)

    Example with custom options:
        >>> opts = BrowserBoxOptions(browser="firefox", memory=4096)
        >>> async with BrowserBox(opts) as browser:
        ...     endpoint = browser.endpoint()
    """

    # Default Playwright images (with retry logic now!)
    _DEFAULT_IMAGE = "mcr.microsoft.com/playwright:v1.47.2-jammy"

    # CDP port for each browser type
    _PORTS = {"chromium": 9222, "firefox": 9223, "webkit": 9224}

    def __init__(
        self,
        options: Optional[BrowserBoxOptions] = None,
        runtime: Optional["Boxlite"] = None,
        **kwargs,
    ):
        """
        Create and auto-start a browser.

        Args:
            options: Browser configuration (uses defaults if None)
            runtime: Optional runtime instance (uses global default if None)
            **kwargs: Additional configuration options (volumes, env, etc.)
        """
        opts = options or BrowserBoxOptions()

        self._browser = opts.browser
        self._port = self._PORTS.get(opts.browser, 9222)

        # Initialize base box
        super().__init__(
            image=self._DEFAULT_IMAGE,
            memory_mib=opts.memory,
            cpus=opts.cpu,
            runtime=runtime,
            **kwargs,
        )

    async def __aenter__(self):
        """Start browser automatically on context enter."""
        await super().__aenter__()
        await self._start_browser()
        return self

    async def _start_browser(self):
        """Internal: Start browser with remote debugging."""
        if self._browser == "chromium":
            binary = "/ms-playwright/chromium-*/chrome-linux/chrome"
            cmd = (
                f"{binary} --headless --no-sandbox --disable-dev-shm-usage "
                f"--disable-gpu --remote-debugging-address=0.0.0.0 "
                f"--remote-debugging-port={self._port} "
                f"> /tmp/browser.log 2>&1 &"
            )
        elif self._browser == "firefox":
            binary = "/ms-playwright/firefox-*/firefox/firefox"
            cmd = (
                f"{binary} --headless "
                f"--remote-debugging-port={self._port} "
                f"> /tmp/browser.log 2>&1 &"
            )
        else:  # webkit
            cmd = (
                f"playwright run-server --browser webkit "
                f"--port {self._port} > /tmp/browser.log 2>&1 &"
            )

        # Start browser in background
        await self.exec("sh", "-c", f"nohup {cmd}")

        # Wait for browser to be ready
        await self.exec("sleep", "3")

    def endpoint(self) -> str:
        """
        Get the connection endpoint for remote debugging.

        Returns:
            HTTP endpoint URL for Chrome DevTools Protocol

        Example:
            >>> async with BrowserBox() as browser:
            ...     url = browser.endpoint()
            ...     # Use with Puppeteer:
            ...     # puppeteer.connect({ browserURL: url })
            ...     # Use with Playwright:
            ...     # chromium.connect_over_cdp(url)
        """
        return f"http://localhost:{self._port}"
