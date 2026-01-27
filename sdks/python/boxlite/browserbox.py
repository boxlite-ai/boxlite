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


# Default CDP port for Puppeteer connections
_CDP_PORT = 9222


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
        ...     endpoint = await browser.playwright_endpoint()
        ...     print(endpoint)
    """

    browser: str = "chromium"  # chromium, firefox, or webkit
    memory: int = 2048  # Memory in MiB
    cpu: int = 2  # Number of CPU cores
    port: Optional[int] = None  # Host port for Playwright Server (default: 3000)
    cdp_port: Optional[int] = None  # Host port for CDP/Puppeteer (default: 9222)


class BrowserBox(SimpleBox):
    """
    Secure browser environment with Playwright Server.

    Auto-starts a browser with Playwright Server enabled for remote control.
    Connect from outside using Playwright's `connect()` method.

    Usage:
        >>> async with BrowserBox() as browser:
        ...     ws = await browser.playwright_endpoint()
        ...     print(f"Connect to: {ws}")
        ...     # Use Playwright from your host to connect
        ...     await asyncio.sleep(60)

    Example with Playwright:
        >>> from playwright.async_api import async_playwright
        >>> async with BrowserBox() as browser:
        ...     ws = await browser.playwright_endpoint()
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

        # CDP port for Puppeteer (only works with chromium)
        self._cdp_guest_port = _CDP_PORT
        self._cdp_host_port = opts.cdp_port or self._cdp_guest_port

        # Track server states
        self._playwright_started = False
        self._cdp_started = False

        # Extract user ports and add port forwarding
        user_ports = kwargs.pop("ports", [])
        default_ports = [
            (self._host_port, self._guest_port),  # Playwright Server
            (self._cdp_host_port, self._cdp_guest_port),  # CDP for Puppeteer
        ]

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
        """Start the box but don't auto-start browser (lazy start via playwright_endpoint)."""
        await super().__aenter__()
        # Don't auto-start browser here - let playwright_endpoint() handle it
        return self

    async def _start_playwright_server(self, timeout: int = 60):
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
        await self._wait_for_playwright_server(timeout)
        self._playwright_started = True

    async def _wait_for_playwright_server(self, timeout: int):
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

    async def _start_puppeteer_browser(self, timeout: int = 60):
        """
        Start browser with remote debugging (for Puppeteer).

        Works with chromium (CDP) and firefox (WebDriver BiDi).
        WebKit is not supported by Puppeteer.

        Args:
            timeout: Maximum time to wait for browser to start in seconds

        Raises:
            ValueError: If browser type is webkit
            RuntimeError: If Playwright is already started
            TimeoutError: If browser doesn't start within timeout
        """
        if self._browser == "webkit":
            raise ValueError(
                "Puppeteer does not support WebKit. "
                "Use playwright_endpoint() with Playwright for webkit."
            )

        # endpoint() and Playwright cannot be used simultaneously (they share port 3000)
        if self._playwright_started:
            raise RuntimeError(
                "Cannot use endpoint() when Playwright Server is already running. "
                "Create a separate BrowserBox instance for Puppeteer usage."
            )

        if self._browser == "chromium":
            await self._start_chromium_cdp(timeout)
        elif self._browser == "firefox":
            await self._start_firefox_bidi(timeout)

        # Start Python TCP forwarder to route traffic through port 3000
        await self._start_cdp_forwarder()

        self._cdp_started = True

    async def _start_chromium_cdp(self, timeout: int):
        """Start Chromium with CDP remote debugging."""
        # Find chromium binary in Playwright's installation directory
        find_chrome = (
            "CHROME=$(find /ms-playwright -name chrome -type f 2>/dev/null | "
            "grep chrome-linux | head -1) && echo $CHROME"
        )
        result = await self.run("sh", "-c", find_chrome)
        chrome_path = result.stdout.strip()

        if not chrome_path:
            raise RuntimeError(
                "Could not find chromium binary in Playwright image. "
                "Make sure you're using the Playwright Docker image."
            )

        # Start chromium with remote debugging enabled
        cmd = (
            f"{chrome_path} --headless --no-sandbox --disable-gpu "
            f"--disable-dev-shm-usage --disable-software-rasterizer "
            f"--no-first-run --disable-extensions "
            f"--user-data-dir=/tmp/chromium-data "
            f"--remote-debugging-address=0.0.0.0 "
            f"--remote-debugging-port={self._cdp_guest_port} "
            f"--remote-allow-origins=* "
            f"> /tmp/chromium-cdp.log 2>&1 &"
        )
        await self.run("sh", "-c", f"nohup {cmd}")
        await self._wait_for_cdp_server(timeout)

    async def _start_firefox_bidi(self, timeout: int):
        """Start Firefox with WebDriver BiDi remote debugging."""
        # Find firefox binary in Playwright's installation directory
        find_firefox = (
            "FF=$(find /ms-playwright -name firefox -type f 2>/dev/null | head -1) && echo $FF"
        )
        result = await self.run("sh", "-c", find_firefox)
        firefox_path = result.stdout.strip()

        if not firefox_path:
            raise RuntimeError(
                "Could not find firefox binary in Playwright image. "
                "Make sure you're using the Playwright Docker image."
            )

        # Create profile directory
        await self.run("sh", "-c", "mkdir -p /tmp/firefox-profile")

        # Firefox uses --remote-debugging-port for WebDriver BiDi
        cmd = (
            f"{firefox_path} --headless --no-remote "
            f"--profile /tmp/firefox-profile "
            f"--remote-debugging-port {self._cdp_guest_port} "
            f"> /tmp/firefox-bidi.log 2>&1 &"
        )
        await self.run("sh", "-c", f"nohup {cmd}")
        await self._wait_for_bidi_server(timeout)

    async def _wait_for_bidi_server(self, timeout: int):
        """Wait for Firefox WebDriver BiDi server to be ready."""
        start = time.time()
        poll_interval = 0.5

        while time.time() - start < timeout:
            # Check log for "WebDriver BiDi listening" message
            check = (
                'grep -q "WebDriver BiDi listening" /tmp/firefox-bidi.log 2>/dev/null '
                "&& echo ready || echo notready"
            )
            result = await self.run("sh", "-c", check)
            if result.stdout.strip() == "ready":
                return
            await asyncio.sleep(poll_interval)

        # Try to get log output for debugging
        log_content = ""
        try:
            log_result = await self.run(
                "sh", "-c", "cat /tmp/firefox-bidi.log 2>/dev/null || echo 'No log'"
            )
            log_content = log_result.stdout.strip()
        except Exception:
            pass

        raise TimeoutError(
            f"Firefox WebDriver BiDi did not start within {timeout}s. "
            f"Log: {log_content[:500]}"
        )

    async def _start_cdp_forwarder(self):
        """Start Python TCP forwarder to route traffic through port 3000."""
        # Python script that forwards TCP connections and rewrites Host header for Firefox
        cdp_port = self._cdp_guest_port
        fwd_port = self._guest_port
        script = f"""import socket, threading, re
def fwd(s,d,rewrite=False):
    try:
        first=True
        while True:
            x=s.recv(65536)
            if not x: break
            if first and rewrite:
                x=re.sub(rb'Host: [^\\r\\n]+',b'Host: 127.0.0.1:{cdp_port}',x)
                first=False
            d.sendall(x)
    except: pass
    s.close(); d.close()
def handle(c):
    try:
        srv=socket.socket()
        srv.connect(('127.0.0.1',{cdp_port}))
        threading.Thread(target=fwd,args=(c,srv,True)).start()
        threading.Thread(target=fwd,args=(srv,c,False)).start()
    except: c.close()
l=socket.socket()
l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
l.bind(('0.0.0.0',{fwd_port}))
l.listen(10)
while True:
    c,_=l.accept()
    threading.Thread(target=handle,args=(c,)).start()
"""
        # Write script and start forwarder
        await self.run("sh", "-c", f"cat > /tmp/cdp_fwd.py << 'ENDPY'\n{script}\nENDPY")
        await self.run("sh", "-c", "nohup python3 /tmp/cdp_fwd.py >/dev/null 2>&1 &")

        # Wait for forwarder to be ready by testing TCP connection
        start_time = time.time()
        while time.time() - start_time < 10:
            # Test forwarder by attempting a TCP connection using Python
            check = await self.run(
                "sh", "-c",
                f"python3 -c \"import socket; s=socket.socket(); s.settimeout(1); "
                f"s.connect(('127.0.0.1',{self._guest_port})); s.close(); print('ready')\" "
                f"2>/dev/null || echo notready"
            )
            if check.stdout.strip() == "ready":
                return
            await asyncio.sleep(0.2)

    async def _wait_for_cdp_server(self, timeout: int):
        """
        Poll until CDP server is ready and get the WebSocket URL.

        Args:
            timeout: Maximum wait time in seconds

        Raises:
            TimeoutError: If server doesn't become ready within timeout
        """
        start = time.time()
        poll_interval = 0.5

        while time.time() - start < timeout:
            # Check if CDP server is responding
            check = (
                f"curl -sf http://{const.GUEST_IP}:{self._cdp_guest_port}/json/version "
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
                "sh", "-c", "cat /tmp/chromium-cdp.log 2>/dev/null || echo 'No log'"
            )
            log_content = log_result.stdout.strip()
        except Exception:
            pass

        raise TimeoutError(
            f"CDP browser did not start within {timeout}s. "
            f"Log: {log_content[:500]}"
        )

    async def playwright_endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for Playwright connect().

        This is the primary method for Playwright connections.
        The returned URL can be used with Playwright's `connect()` method.
        Auto-starts the Playwright Server if not already started.

        Args:
            timeout: Maximum time to wait for server to start (if needed)

        Returns:
            WebSocket endpoint URL (e.g., 'ws://localhost:3000/')

        Example:
            >>> async with BrowserBox() as browser:
            ...     ws = await browser.playwright_endpoint()
            ...     # Use with Playwright:
            ...     # browser = await chromium.connect(ws)
        """
        if not self._playwright_started:
            await self._start_playwright_server(timeout)
        return f"ws://localhost:{self._host_port}/"

    async def ws_endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for Playwright connect().

        .. deprecated::
            Use :meth:`playwright_endpoint` instead.
        """
        return await self.playwright_endpoint(timeout)

    async def endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for CDP/BiDi connections.

        This is the generic endpoint that works with Puppeteer, Selenium, or any
        other CDP/BiDi client. Works with chromium (CDP) and firefox (WebDriver BiDi).
        WebKit is not supported - use playwright_endpoint() with Playwright instead.

        Args:
            timeout: Maximum time to wait for browser to start (if needed)

        Returns:
            WebSocket endpoint URL

        Raises:
            ValueError: If browser type is webkit

        Example:
            >>> # Chromium (CDP)
            >>> async with BrowserBox() as browser:
            ...     ws_endpoint = await browser.endpoint()
            ...     # browser = await puppeteer.connect(browserWSEndpoint=ws_endpoint)

            >>> # Firefox (WebDriver BiDi)
            >>> async with BrowserBox(BrowserBoxOptions(browser="firefox")) as browser:
            ...     ws_endpoint = await browser.endpoint()
            ...     # browser = await puppeteer.connect(
            ...     #     browserWSEndpoint=ws_endpoint,
            ...     #     protocol='webDriverBiDi'
            ...     # )
            ...     # Note: Firefox headless has a limitation where newPage() hangs.
            ...     # Use browser.pages()[0] instead of browser.newPage().
        """
        if not self._cdp_started:
            await self._start_puppeteer_browser(timeout)

        if self._browser == "firefox":
            # Firefox WebDriver BiDi requires /session path for WebSocket upgrade
            # See: https://github.com/puppeteer/puppeteer/issues/13057
            return f"ws://localhost:{self._host_port}/session"

        # Chromium: Fetch the WebSocket URL from CDP endpoint
        import json

        result = await self.run(
            "sh", "-c",
            f"curl -sf http://{const.GUEST_IP}:{self._cdp_guest_port}/json/version"
        )
        version_info = json.loads(result.stdout)
        ws_url = version_info.get("webSocketDebuggerUrl", "")

        # Replace internal address with localhost:host_port
        # CDP traffic is routed through port 3000 via the Python forwarder
        import re
        ws_url = re.sub(r"ws://[^:]+:\d+", f"ws://localhost:{self._host_port}", ws_url)

        return ws_url

    async def puppeteer_endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for Puppeteer connect().

        .. deprecated::
            Use :meth:`endpoint` instead.
        """
        return await self.endpoint(timeout)

    async def cdp_endpoint(self, timeout: int = 60) -> str:
        """
        Get the CDP WebSocket endpoint for Puppeteer connect().

        .. deprecated::
            Use :meth:`endpoint` instead. This method only works with chromium.

        Args:
            timeout: Maximum time to wait for browser to start (if needed)

        Returns:
            CDP WebSocket endpoint URL

        Raises:
            ValueError: If browser type is not chromium
        """
        if self._browser != "chromium":
            raise ValueError(
                f"cdp_endpoint() only works with chromium. "
                f"For {self._browser}, use endpoint() instead."
            )
        return await self.endpoint(timeout)

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
        ws = await self.playwright_endpoint(timeout)

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
