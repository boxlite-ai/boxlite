/**
 * BrowserBox - Secure browser with Playwright Server.
 *
 * Provides a minimal, elegant API for running isolated browsers that can be
 * controlled from outside using Playwright. Supports all browser types:
 * chromium, firefox, and webkit.
 */

import { SimpleBox, type SimpleBoxOptions } from "./simplebox.js";
import { BoxliteError, TimeoutError } from "./errors.js";
import * as constants from "./constants.js";

/**
 * Browser type supported by BrowserBox.
 */
export type BrowserType = "chromium" | "firefox" | "webkit";

/** Default CDP port for Puppeteer connections */
const CDP_PORT = 9222;

/**
 * Options for creating a BrowserBox.
 */
export interface BrowserBoxOptions extends Omit<
  SimpleBoxOptions,
  "image" | "cpus" | "memoryMib"
> {
  /** Browser type (default: 'chromium') */
  browser?: BrowserType;

  /** Memory in MiB (default: 2048) */
  memoryMib?: number;

  /** Number of CPU cores (default: 2) */
  cpus?: number;

  /** Host port for Playwright Server WebSocket connection (default: 3000) */
  port?: number;

  /** Host port for CDP/Puppeteer connection (default: 9222) */
  cdpPort?: number;
}

/**
 * Secure browser environment with Playwright Server.
 *
 * Auto-starts a browser with Playwright Server enabled for remote control.
 * Connect from outside using Playwright's `connect()` method.
 *
 * ## Usage
 *
 * ```typescript
 * import { BrowserBox } from '@boxlite-ai/boxlite';
 * import { chromium } from 'playwright-core';
 *
 * const box = new BrowserBox({ browser: 'chromium' });
 * try {
 *   const ws = await box.playwrightEndpoint();
 *   const browser = await chromium.connect(ws);
 *
 *   const page = await browser.newPage();
 *   await page.goto('https://example.com');
 *   console.log(await page.title());
 *
 *   await browser.close();
 * } finally {
 *   await box.stop();
 * }
 * ```
 *
 * ## All browsers supported
 *
 * ```typescript
 * // WebKit works!
 * const box = new BrowserBox({ browser: 'webkit' });
 * const ws = await box.playwrightEndpoint();
 * const browser = await webkit.connect(ws);
 * ```
 */
export class BrowserBox extends SimpleBox {
  /** Playwright Docker image with all browsers pre-installed */
  private static readonly DEFAULT_IMAGE =
    "mcr.microsoft.com/playwright:v1.58.0-jammy";

  /** Playwright version - must match the Docker image */
  private static readonly PLAYWRIGHT_VERSION = "1.58.0";

  /** Default port for Playwright Server */
  private static readonly DEFAULT_PORT = constants.BROWSERBOX_PORT;

  private readonly _browser: BrowserType;
  private readonly _guestPort: number;
  private readonly _hostPort: number;
  private readonly _cdpGuestPort: number;
  private _playwrightStarted: boolean = false;
  private _cdpStarted: boolean = false;

  /**
   * Create a new BrowserBox.
   *
   * @param options - BrowserBox configuration options
   *
   * @example
   * ```typescript
   * const browser = new BrowserBox({
   *   browser: 'webkit',  // All browsers work!
   *   memoryMib: 2048,
   *   cpus: 2
   * });
   * ```
   */
  constructor(options: BrowserBoxOptions = {}) {
    const {
      browser = "chromium",
      memoryMib = 2048,
      cpus = 2,
      port,
      cdpPort,
      ports: userPorts = [],
      ...restOptions
    } = options;

    // Playwright Server ports
    const guestPort = BrowserBox.DEFAULT_PORT;
    const hostPort = port ?? guestPort;

    // CDP ports for Puppeteer
    const cdpGuestPort = CDP_PORT;
    const cdpHostPort = cdpPort ?? cdpGuestPort;

    // Add port forwarding for both Playwright Server and CDP
    const defaultPorts = [
      { hostPort, guestPort },           // Playwright Server
      { hostPort: cdpHostPort, guestPort: cdpGuestPort },  // CDP for Puppeteer
    ];

    super({
      ...restOptions,
      image: BrowserBox.DEFAULT_IMAGE,
      memoryMib,
      cpus,
      ports: [...defaultPorts, ...userPorts],
    });

    this._browser = browser;
    this._guestPort = guestPort;
    this._hostPort = hostPort;
    this._cdpGuestPort = cdpGuestPort;
  }

  /**
   * Start the Playwright Server with the configured browser.
   *
   * The Playwright Server binds to 0.0.0.0, so no proxy is needed.
   * It handles all browser types natively.
   *
   * @param timeout - Maximum time to wait for server to start in seconds (default: 60)
   * @throws {TimeoutError} If server doesn't start within timeout
   */
  async start(timeout: number = 60): Promise<void> {
    await this._startPlaywrightServer(timeout);
  }

  /** Start Playwright Server (works for ALL browsers). */
  private async _startPlaywrightServer(timeout: number = 60): Promise<void> {
    const startCmd =
      `npx -y playwright@${BrowserBox.PLAYWRIGHT_VERSION} run-server ` +
      `--port ${this._guestPort} --host 0.0.0.0 > /tmp/playwright.log 2>&1 &`;

    await this.exec("sh", "-c", `nohup ${startCmd}`);
    await this._waitForPlaywrightServer(timeout);
    this._playwrightStarted = true;
  }

  /** Wait for Playwright Server to be ready. */
  private async _waitForPlaywrightServer(timeout: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > timeout) {
        let logContent = "";
        try {
          const logResult = await this.exec("sh", "-c", "cat /tmp/playwright.log 2>/dev/null || echo 'No log'");
          logContent = logResult.stdout.trim();
        } catch {
          // Ignore errors reading log
        }
        throw new TimeoutError(
          `Playwright Server (${this._browser}) did not start within ${timeout}s. Log: ${logContent.slice(0, 500)}`
        );
      }

      const checkCmd = `curl -sf http://${constants.GUEST_IP}:${this._guestPort}/json > /dev/null 2>&1 && echo ready || echo notready`;
      const result = await this.exec("sh", "-c", checkCmd);
      if (result.stdout.trim() === "ready") return;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Start browser with remote debugging for Puppeteer (CDP for Chromium, WebDriver BiDi for Firefox). */
  private async _startCdpBrowser(timeout: number = 60): Promise<void> {
    if (this._browser === "webkit") {
      throw new BoxliteError(
        "Puppeteer does not support WebKit. Use playwrightEndpoint() with Playwright for webkit."
      );
    }

    // endpoint() and Playwright cannot be used simultaneously (they share port 3000 for forwarding)
    if (this._playwrightStarted) {
      throw new BoxliteError(
        "Cannot use endpoint() when Playwright Server is already running. " +
        "Create a separate BrowserBox instance for Puppeteer usage."
      );
    }

    if (this._browser === "chromium") {
      await this._startChromiumCdp(timeout);
    } else if (this._browser === "firefox") {
      await this._startFirefoxBiDi(timeout);
    }

    // Start Python TCP forwarder to route traffic through port 3000 (which has working port forwarding)
    await this._startCdpForwarder();

    this._cdpStarted = true;
  }

  /** Start Chromium with CDP remote debugging. */
  private async _startChromiumCdp(timeout: number): Promise<void> {
    // Find chromium binary in Playwright's installation directory
    const findChrome = `CHROME=$(find /ms-playwright -name chrome -type f 2>/dev/null | grep chrome-linux | head -1) && echo $CHROME`;
    const findResult = await this.exec("sh", "-c", findChrome);
    const chromePath = findResult.stdout.trim();

    if (!chromePath) {
      throw new BoxliteError(
        "Could not find chromium binary in Playwright image. Make sure you're using the Playwright Docker image."
      );
    }

    const startCmd =
      `${chromePath} --headless --no-sandbox --disable-gpu --disable-dev-shm-usage ` +
      `--disable-software-rasterizer --no-first-run --disable-extensions ` +
      `--user-data-dir=/tmp/chromium-data ` +
      `--remote-debugging-address=0.0.0.0 --remote-debugging-port=${this._cdpGuestPort} ` +
      `--remote-allow-origins=* ` +
      `> /tmp/chromium-cdp.log 2>&1 &`;

    await this.exec("sh", "-c", `nohup ${startCmd}`);
    await this._waitForCdpServer(timeout);
  }

  /** Start Firefox with WebDriver BiDi remote debugging. */
  private async _startFirefoxBiDi(timeout: number): Promise<void> {
    // Find firefox binary in Playwright's installation directory
    const findFirefox = `FF=$(find /ms-playwright -name firefox -type f 2>/dev/null | head -1) && echo $FF`;
    const findResult = await this.exec("sh", "-c", findFirefox);
    const firefoxPath = findResult.stdout.trim();

    if (!firefoxPath) {
      throw new BoxliteError(
        "Could not find firefox binary in Playwright image. Make sure you're using the Playwright Docker image."
      );
    }

    // Firefox uses --remote-debugging-port for WebDriver BiDi
    const startCmd =
      `${firefoxPath} --headless --no-remote ` +
      `--profile /tmp/firefox-profile ` +
      `--remote-debugging-port ${this._cdpGuestPort} ` +
      `> /tmp/firefox-bidi.log 2>&1 &`;

    // Create profile directory
    await this.exec("sh", "-c", "mkdir -p /tmp/firefox-profile");
    await this.exec("sh", "-c", `nohup ${startCmd}`);
    await this._waitForBiDiServer(timeout);
  }

  /** Wait for Firefox WebDriver BiDi server to be ready. */
  private async _waitForBiDiServer(timeout: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > timeout) {
        let logContent = "";
        try {
          const logResult = await this.exec("sh", "-c", "cat /tmp/firefox-bidi.log 2>/dev/null || echo 'No log'");
          logContent = logResult.stdout.trim();
        } catch {
          // Ignore errors
        }
        throw new TimeoutError(
          `Firefox WebDriver BiDi did not start within ${timeout}s.\nLog: ${logContent.slice(0, 500)}`
        );
      }

      // Check log for "WebDriver BiDi listening" message
      const checkCmd = `grep -q "WebDriver BiDi listening" /tmp/firefox-bidi.log 2>/dev/null && echo ready || echo notready`;
      const result = await this.exec("sh", "-c", checkCmd);
      if (result.stdout.trim() === "ready") return;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Start Python TCP forwarder to route traffic through the working port 3000. */
  private async _startCdpForwarder(): Promise<void> {
    // Python script that forwards TCP connections and rewrites Host header for Firefox
    const cdpPort = this._cdpGuestPort;
    const fwdPort = this._guestPort;
    const script = [
      "import socket, threading, re",
      "def fwd(s,d,rewrite=False):",
      "    try:",
      "        first=True",
      "        while True:",
      "            x=s.recv(65536)",
      "            if not x: break",
      "            if first and rewrite:",
      `                x=re.sub(rb'Host: [^\\r\\n]+',b'Host: 127.0.0.1:${cdpPort}',x)`,
      "                first=False",
      "            d.sendall(x)",
      "    except: pass",
      "    s.close(); d.close()",
      "def handle(c):",
      "    try:",
      "        srv=socket.socket()",
      `        srv.connect(('127.0.0.1',${cdpPort}))`,
      "        threading.Thread(target=fwd,args=(c,srv,True)).start()",
      "        threading.Thread(target=fwd,args=(srv,c,False)).start()",
      "    except: c.close()",
      "l=socket.socket()",
      "l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)",
      `l.bind(('0.0.0.0',${fwdPort}))`,
      "l.listen(10)",
      "while True:",
      "    c,_=l.accept()",
      "    threading.Thread(target=handle,args=(c,)).start()",
    ].join("\n");

    await this.exec("sh", "-c", `printf '%s' '${script.replace(/'/g, "'\\''")}' > /tmp/cdp_fwd.py`);
    await this.exec("sh", "-c", "nohup python3 /tmp/cdp_fwd.py >/dev/null 2>&1 &");

    // Wait for forwarder to be ready by testing connection
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      // Test forwarder by attempting a TCP connection using Python
      const checkCmd = `python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('127.0.0.1',${this._guestPort})); s.close(); print('ready')" 2>/dev/null || echo notready`;
      const check = await this.exec("sh", "-c", checkCmd);
      if (check.stdout.trim() === "ready") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Wait for CDP server to be ready. */
  private async _waitForCdpServer(timeout: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > timeout) {
        let logContent = "";
        let processInfo = "";
        let portInfo = "";
        try {
          const logResult = await this.exec("sh", "-c", "cat /tmp/chromium-cdp.log 2>/dev/null || echo 'No log'");
          logContent = logResult.stdout.trim();
          const psResult = await this.exec("sh", "-c", "ps aux | grep -i chrom | head -5");
          processInfo = psResult.stdout.trim();
          const netResult = await this.exec("sh", "-c", `netstat -tlnp 2>/dev/null | grep ${this._cdpGuestPort} || ss -tlnp 2>/dev/null | grep ${this._cdpGuestPort} || echo 'Port not bound'`);
          portInfo = netResult.stdout.trim();
        } catch {
          // Ignore errors
        }
        throw new TimeoutError(
          `CDP browser did not start within ${timeout}s.\n` +
          `Log: ${logContent.slice(0, 500)}\n` +
          `Processes: ${processInfo}\n` +
          `Port ${this._cdpGuestPort}: ${portInfo}`
        );
      }

      // Try both localhost and GUEST_IP since chromium binds to 0.0.0.0
      const checkCmd = `(curl -sf http://localhost:${this._cdpGuestPort}/json/version > /dev/null 2>&1 || curl -sf http://${constants.GUEST_IP}:${this._cdpGuestPort}/json/version > /dev/null 2>&1) && echo ready || echo notready`;
      const result = await this.exec("sh", "-c", checkCmd);
      if (result.stdout.trim() === "ready") return;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Ensure Playwright server is started. */
  private async _ensurePlaywrightStarted(timeout?: number): Promise<void> {
    if (!this._playwrightStarted) {
      await this._startPlaywrightServer(timeout ?? 60);
    }
  }

  /** Ensure CDP browser is started. */
  private async _ensureCdpStarted(timeout?: number): Promise<void> {
    if (!this._cdpStarted) {
      await this._startCdpBrowser(timeout ?? 60);
    }
  }

  /**
   * Get the WebSocket endpoint for Playwright connect().
   *
   * This is the primary method for Playwright connections.
   * The returned URL can be used with Playwright's `connect()` method.
   *
   * @param timeout - Optional timeout to wait for server to start (starts automatically if not started)
   * @returns WebSocket endpoint URL (e.g., 'ws://localhost:3000/')
   *
   * @example
   * ```typescript
   * const box = new BrowserBox({ browser: 'chromium' });
   * const ws = await box.playwrightEndpoint();
   * const browser = await chromium.connect(ws);
   * ```
   */
  async playwrightEndpoint(timeout?: number): Promise<string> {
    await this._ensurePlaywrightStarted(timeout);
    return `ws://localhost:${this._hostPort}/`;
  }

  /**
   * @deprecated Use playwrightEndpoint() instead.
   */
  async wsEndpoint(timeout?: number): Promise<string> {
    return this.playwrightEndpoint(timeout);
  }

  /**
   * Get the WebSocket endpoint for CDP/BiDi connections.
   *
   * This is the generic endpoint that works with Puppeteer, Selenium, or any
   * other CDP/BiDi client. Works with chromium (CDP) and firefox (WebDriver BiDi).
   * WebKit is not supported - use playwrightEndpoint() with Playwright instead.
   *
   * @param timeout - Optional timeout to wait for browser to start
   * @returns WebSocket endpoint URL
   * @throws {BoxliteError} If browser type is webkit
   *
   * @example
   * ```typescript
   * // Chromium (CDP)
   * const box = new BrowserBox({ browser: 'chromium' });
   * const wsEndpoint = await box.endpoint();
   * const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
   *
   * // Firefox (WebDriver BiDi)
   * const box = new BrowserBox({ browser: 'firefox' });
   * const wsEndpoint = await box.endpoint();
   * const browser = await puppeteer.connect({
   *   browserWSEndpoint: wsEndpoint,
   *   protocol: 'webDriverBiDi'
   * });
   * // Note: Firefox headless has a limitation where newPage() hangs.
   * // Use browser.pages()[0] instead of browser.newPage().
   * const page = (await browser.pages())[0];
   * ```
   */
  async endpoint(timeout?: number): Promise<string> {
    await this._ensureCdpStarted(timeout);

    if (this._browser === "firefox") {
      // Firefox WebDriver BiDi requires /session path for WebSocket upgrade
      // See: https://github.com/puppeteer/puppeteer/issues/13057
      return `ws://localhost:${this._hostPort}/session`;
    }

    // Chromium: Fetch the WebSocket URL from CDP endpoint
    const result = await this.exec(
      "sh", "-c",
      `curl -sf http://localhost:${this._cdpGuestPort}/json/version`
    );

    if (!result.stdout.trim()) {
      throw new BoxliteError("CDP endpoint returned empty response");
    }

    const versionInfo = JSON.parse(result.stdout);
    let wsUrl = versionInfo.webSocketDebuggerUrl || "";

    if (!wsUrl) {
      throw new BoxliteError("CDP endpoint did not return webSocketDebuggerUrl");
    }

    // Replace the internal address with localhost:hostPort
    // Traffic is routed through port 3000 via the Python forwarder
    wsUrl = wsUrl.replace(/ws:\/\/[^:]+:\d+/, `ws://localhost:${this._hostPort}`);

    return wsUrl;
  }

  /**
   * @deprecated Use endpoint() instead.
   */
  async puppeteerEndpoint(timeout?: number): Promise<string> {
    return this.endpoint(timeout);
  }

  /**
   * @deprecated Use endpoint() instead. This method only works with chromium.
   */
  async cdpEndpoint(timeout?: number): Promise<string> {
    if (this._browser !== "chromium") {
      throw new BoxliteError(
        `cdpEndpoint() only works with chromium. For ${this._browser}, use endpoint() instead.`
      );
    }
    return this.endpoint(timeout);
  }

  /**
   * Connect to the browser using Playwright.
   *
   * Convenience method that returns a connected Playwright Browser instance.
   * Requires playwright-core to be installed.
   *
   * @param options - Connection options
   * @returns Connected Playwright Browser instance
   *
   * @example
   * ```typescript
   * const box = new BrowserBox({ browser: 'webkit' });
   * const browser = await box.connect();
   * const page = await browser.newPage();
   * await page.goto('https://example.com');
   * ```
   */
  async connect(options?: { timeout?: number }): Promise<unknown> {
    const ws = await this.playwrightEndpoint(options?.timeout);

    // Dynamic import to avoid requiring playwright-core as a dependency
    const playwright = await import("playwright-core");
    const browserType = playwright[this._browser as keyof typeof playwright] as
      | { connect: (url: string) => Promise<unknown> }
      | undefined;

    if (!browserType?.connect) {
      throw new BoxliteError(`Unknown browser type: ${this._browser}`);
    }

    return browserType.connect(ws);
  }

  /**
   * Get the browser type.
   *
   * @returns The browser type ('chromium', 'firefox', or 'webkit')
   */
  get browser(): BrowserType {
    return this._browser;
  }
}
