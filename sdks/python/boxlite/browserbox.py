"""
BrowserBox - Secure browser with Playwright Server.

Provides a minimal, elegant API for running isolated browsers that can be
controlled from outside using Playwright. Supports all browser types:
chromium, firefox, and webkit.

Connection Modes
----------------
BrowserBox provides two ways to connect:

1. **Playwright Server Mode** (``playwright_endpoint()``):
   - Starts ``playwright run-server`` on port 3000
   - Works with ALL browsers (chromium, firefox, webkit)
   - Clients connect via WebSocket to control the browser
   - Recommended for most use cases

2. **Direct CDP/BiDi Mode** (``endpoint()``):
   - Starts browser directly with remote debugging
   - Chromium: Uses Chrome DevTools Protocol (CDP) on port 9222
   - Firefox: Uses WebDriver BiDi protocol on port 9222
   - WebKit: NOT SUPPORTED (Puppeteer limitation)
   - Traffic routed through port 3000 via TCP forwarder
     (workaround for VM port forwarding limitations)

These modes are MUTUALLY EXCLUSIVE - use one or the other per instance.
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


# =============================================================================
# Constants
# =============================================================================

# Default CDP port for remote debugging (Chromium CDP / Firefox BiDi)
_CDP_PORT = 9222

# Polling interval for service readiness checks (seconds)
_POLL_INTERVAL = 0.5

# Log file paths inside the VM
_PLAYWRIGHT_LOG = "/tmp/playwright.log"
_CHROMIUM_CDP_LOG = "/tmp/chromium-cdp.log"
_FIREFOX_BIDI_LOG = "/tmp/firefox-bidi.log"

# Playwright installation path in Docker image
_PLAYWRIGHT_INSTALL_PATH = "/ms-playwright"

# Browser data directories
_CHROMIUM_DATA_DIR = "/tmp/chromium-data"
_FIREFOX_PROFILE_DIR = "/tmp/firefox-profile"

# Timeout for CDP forwarder startup (seconds)
_CDP_FORWARDER_TIMEOUT = 10

# TCP buffer size for forwarder
_TCP_BUFFER_SIZE = 65536


# =============================================================================
# Types
# =============================================================================


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

    # =========================================================================
    # Private: Generic Polling Helper
    # =========================================================================

    async def _poll_until_ready(
        self,
        check_cmd: str,
        service_name: str,
        log_path: str,
        timeout: int,
    ) -> None:
        """
        Poll until a check command returns "ready" or timeout expires.

        This is the core polling pattern used by all service startup methods.
        The check command should output "ready" when the service is available,
        or any other string (typically "notready") otherwise.

        Args:
            check_cmd: Shell command that outputs "ready" when service is available
            service_name: Human-readable name for error messages
            log_path: Path to log file for debugging on failure
            timeout: Maximum wait time in seconds

        Raises:
            TimeoutError: If service doesn't become ready within timeout
        """
        start = time.time()

        while time.time() - start < timeout:
            result = await self.exec("sh", "-c", check_cmd)
            if result.stdout.strip() == "ready":
                return
            await asyncio.sleep(_POLL_INTERVAL)

        # Fetch log content for debugging
        log_content = ""
        try:
            log_result = await self.exec(
                "sh", "-c", f"cat {log_path} 2>/dev/null || echo 'No log'"
            )
            log_content = log_result.stdout.strip()
        except Exception:
            pass

        raise TimeoutError(
            f"{service_name} did not start within {timeout}s. Log: {log_content[:500]}"
        )

    # =========================================================================
    # Private: Playwright Server
    # =========================================================================

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
            f"> {_PLAYWRIGHT_LOG} 2>&1 &"
        )
        await self.exec("sh", "-c", f"nohup {cmd}")

        # Check if server responds to /json endpoint (Playwright's health check)
        check_cmd = (
            f"curl -sf http://{const.GUEST_IP}:{self._guest_port}/json "
            f"> /dev/null 2>&1 && echo ready || echo notready"
        )
        await self._poll_until_ready(
            check_cmd,
            f"Playwright Server ({self._browser})",
            _PLAYWRIGHT_LOG,
            timeout,
        )
        self._playwright_started = True

    # =========================================================================
    # Private: CDP/BiDi Browser (for Puppeteer)
    # =========================================================================

    async def _start_puppeteer_browser(self, timeout: int = 60):
        """
        Start browser with remote debugging for Puppeteer.

        Chromium uses Chrome DevTools Protocol (CDP).
        Firefox uses WebDriver BiDi protocol.
        WebKit is NOT supported by Puppeteer.

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

        # Playwright Server and CDP browser cannot run simultaneously because
        # both need port 3000 for the host-accessible endpoint.
        if self._playwright_started:
            raise RuntimeError(
                "Cannot use endpoint() when Playwright Server is already running. "
                "Create a separate BrowserBox instance for Puppeteer usage."
            )

        if self._browser == "chromium":
            await self._start_chromium_cdp(timeout)
        elif self._browser == "firefox":
            await self._start_firefox_bidi(timeout)

        # Port 3000 is the only port with reliable VM port forwarding.
        # CDP runs on 9222 internally, but we route it through 3000 externally.
        await self._start_cdp_forwarder()

        self._cdp_started = True

    async def _start_chromium_cdp(self, timeout: int):
        """Start Chromium with CDP remote debugging."""
        # Playwright Docker images install browsers under /ms-playwright/.
        # The exact path varies by version, so we search dynamically.
        find_chrome = (
            f"CHROME=$(find {_PLAYWRIGHT_INSTALL_PATH} -name chrome -type f 2>/dev/null | "
            "grep chrome-linux | head -1) && echo $CHROME"
        )
        result = await self.exec("sh", "-c", find_chrome)
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
            f"--user-data-dir={_CHROMIUM_DATA_DIR} "
            f"--remote-debugging-address=0.0.0.0 "
            f"--remote-debugging-port={self._cdp_guest_port} "
            f"--remote-allow-origins=* "
            f"> {_CHROMIUM_CDP_LOG} 2>&1 &"
        )
        await self.exec("sh", "-c", f"nohup {cmd}")

        # Check CDP /json/version endpoint (standard health check)
        # Try both localhost AND GUEST_IP - Chrome's --remote-debugging-address=0.0.0.0
        # is deprecated and Chrome always binds to localhost (127.0.0.1)
        check_cmd = (
            f"(curl -sf http://localhost:{self._cdp_guest_port}/json/version > /dev/null 2>&1 || "
            f"curl -sf http://{const.GUEST_IP}:{self._cdp_guest_port}/json/version > /dev/null 2>&1) "
            f"&& echo ready || echo notready"
        )
        await self._poll_until_ready(
            check_cmd, "CDP browser", _CHROMIUM_CDP_LOG, timeout
        )

    async def _start_firefox_bidi(self, timeout: int):
        """Start Firefox with WebDriver BiDi remote debugging."""
        # Playwright Docker images install browsers under /ms-playwright/.
        find_firefox = f"FF=$(find {_PLAYWRIGHT_INSTALL_PATH} -name firefox -type f 2>/dev/null | head -1) && echo $FF"
        result = await self.exec("sh", "-c", find_firefox)
        firefox_path = result.stdout.strip()

        if not firefox_path:
            raise RuntimeError(
                "Could not find firefox binary in Playwright image. "
                "Make sure you're using the Playwright Docker image."
            )

        # Create profile directory
        await self.exec("sh", "-c", f"mkdir -p {_FIREFOX_PROFILE_DIR}")

        # Firefox uses --remote-debugging-port for WebDriver BiDi
        cmd = (
            f"{firefox_path} --headless --no-remote "
            f"--profile {_FIREFOX_PROFILE_DIR} "
            f"--remote-debugging-port {self._cdp_guest_port} "
            f"> {_FIREFOX_BIDI_LOG} 2>&1 &"
        )
        await self.exec("sh", "-c", f"nohup {cmd}")

        # Firefox logs "WebDriver BiDi listening" when ready
        check_cmd = (
            f'grep -q "WebDriver BiDi listening" {_FIREFOX_BIDI_LOG} 2>/dev/null '
            "&& echo ready || echo notready"
        )
        await self._poll_until_ready(
            check_cmd, "Firefox WebDriver BiDi", _FIREFOX_BIDI_LOG, timeout
        )

    # =========================================================================
    # Private: TCP Forwarder
    # =========================================================================

    async def _start_cdp_forwarder(self):
        """
        Start TCP forwarder to route CDP traffic through port 3000.

        Why this is needed:
        - VM port forwarding only works reliably on port 3000
        - CDP/BiDi runs on port 9222 internally
        - This forwarder bridges port 3000 → 9222 inside the VM

        The forwarder also rewrites the HTTP Host header because Firefox
        WebDriver BiDi validates that the Host header matches its listening address.
        """
        cdp_port = self._cdp_guest_port
        forwarder_port = self._guest_port

        # Python TCP forwarder script with clear variable names
        script = f'''"""TCP forwarder: routes traffic from port {forwarder_port} to {cdp_port}.

Required because VM port forwarding only works reliably on port 3000.
Rewrites HTTP Host header so Firefox WebDriver BiDi accepts connections.
"""
import socket
import threading
import re

def forward_data(source, destination, rewrite_host=False):
    """Forward data between sockets, optionally rewriting Host header."""
    try:
        is_first_chunk = True
        while True:
            data = source.recv({_TCP_BUFFER_SIZE})
            if not data:
                break
            # Firefox BiDi requires Host header to match its listening address
            if is_first_chunk and rewrite_host:
                data = re.sub(
                    rb'Host: [^\\r\\n]+',
                    b'Host: 127.0.0.1:{cdp_port}',
                    data
                )
                is_first_chunk = False
            destination.sendall(data)
    except Exception:
        pass  # Connection closed
    finally:
        source.close()
        destination.close()

def handle_connection(client_socket):
    """Handle incoming connection by forwarding to CDP server."""
    try:
        server_socket = socket.socket()
        server_socket.connect(('127.0.0.1', {cdp_port}))
        # Bidirectional forwarding
        threading.Thread(
            target=forward_data,
            args=(client_socket, server_socket, True)
        ).start()
        threading.Thread(
            target=forward_data,
            args=(server_socket, client_socket, False)
        ).start()
    except Exception:
        client_socket.close()

# Start listening
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('0.0.0.0', {forwarder_port}))
listener.listen(10)

while True:
    client, _ = listener.accept()
    threading.Thread(target=handle_connection, args=(client,)).start()
'''
        # Write script using heredoc to handle special characters safely
        await self.exec(
            "sh", "-c", f"cat > /tmp/cdp_fwd.py << 'ENDSCRIPT'\n{script}\nENDSCRIPT"
        )
        await self.exec("sh", "-c", "nohup python3 /tmp/cdp_fwd.py >/dev/null 2>&1 &")

        # Wait for forwarder to accept connections
        start_time = time.time()
        while time.time() - start_time < _CDP_FORWARDER_TIMEOUT:
            check = await self.exec(
                "sh",
                "-c",
                f'python3 -c "import socket; s=socket.socket(); s.settimeout(1); '
                f"s.connect(('127.0.0.1',{forwarder_port})); s.close(); print('ready')\" "
                f"2>/dev/null || echo notready",
            )
            if check.stdout.strip() == "ready":
                return
            await asyncio.sleep(0.2)

    # =========================================================================
    # Public API: Endpoints
    # =========================================================================

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

    async def endpoint(self, timeout: int = 60) -> str:
        """
        Get the WebSocket endpoint for CDP/BiDi connections.

        This is the generic endpoint that works with Puppeteer, Selenium, or any
        other CDP/BiDi client. Works with chromium (CDP) and firefox (WebDriver BiDi).
        WebKit is not supported - use playwright_endpoint() with Playwright instead.

        Auto-starts the browser with remote debugging if not already running.

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
            # Firefox WebDriver BiDi requires /session path for WebSocket upgrade.
            # See: https://github.com/puppeteer/puppeteer/issues/13057
            return f"ws://localhost:{self._host_port}/session"

        # Chromium: Fetch the WebSocket URL from CDP /json/version endpoint
        # Use localhost because Chrome binds to 127.0.0.1 (--remote-debugging-address=0.0.0.0 is deprecated)
        import json

        result = await self.exec(
            "sh", "-c", f"curl -sf http://localhost:{self._cdp_guest_port}/json/version"
        )
        version_info = json.loads(result.stdout)
        ws_url = version_info.get("webSocketDebuggerUrl", "")

        # Replace internal address with localhost:host_port.
        # CDP traffic is routed through port 3000 via the TCP forwarder.
        import re

        ws_url = re.sub(r"ws://[^:]+:\d+", f"ws://localhost:{self._host_port}", ws_url)

        return ws_url

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
