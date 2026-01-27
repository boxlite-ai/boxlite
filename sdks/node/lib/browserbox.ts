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

  /** Host port for WebSocket connection (default: 3000) */
  port?: number;
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
 *   const wsEndpoint = await box.wsEndpoint();
 *   const browser = await chromium.connect(wsEndpoint);
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
 * const wsEndpoint = await box.wsEndpoint();
 * const browser = await webkit.connect(wsEndpoint);
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
  private _started: boolean = false;

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
      ports: userPorts = [],
      ...restOptions
    } = options;

    // Guest port is fixed (internal implementation)
    const guestPort = BrowserBox.DEFAULT_PORT;
    // Host port is user-configurable
    const hostPort = port ?? guestPort;

    // Add port forwarding
    const defaultPorts = [{ hostPort, guestPort }];

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
  }

  /**
   * Start the Playwright Server with the configured browser.
   *
   * The Playwright Server binds to 0.0.0.0, so no proxy is needed.
   * It handles all browser types natively.
   *
   * @param timeout - Maximum time to wait for server to start in seconds (default: 60)
   * @throws {TimeoutError} If server doesn't start within timeout
   *
   * @example
   * ```typescript
   * const box = new BrowserBox({ browser: 'firefox' });
   * await box.start();
   * console.log(`Connect to: ${await box.wsEndpoint()}`);
   * ```
   */
  async start(timeout: number = 60): Promise<void> {
    // Start Playwright Server (works for ALL browsers)
    // The server binds to 0.0.0.0, eliminating the need for TCP proxy
    // Note: Browser type is specified by the client when connecting, not the server
    const cmd =
      `npx -y playwright@${BrowserBox.PLAYWRIGHT_VERSION} run-server ` +
      `--port ${this._guestPort} ` +
      `--host 0.0.0.0 ` +
      `> /tmp/playwright.log 2>&1 &`;

    await this.exec("sh", "-c", `nohup ${cmd}`);
    await this._waitForServer(timeout);
    this._started = true;
  }

  /**
   * Wait for Playwright Server to be ready.
   *
   * Polls the server endpoint until it responds.
   *
   * @param timeout - Maximum wait time in seconds
   * @throws {TimeoutError} If server doesn't become ready within timeout
   */
  private async _waitForServer(timeout: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > timeout) {
        // Try to get log output for debugging
        let logContent = "";
        try {
          const logResult = await this.exec("sh", "-c", "cat /tmp/playwright.log 2>/dev/null || echo 'No log'");
          logContent = logResult.stdout.trim();
        } catch {
          // Ignore errors reading log
        }

        throw new TimeoutError(
          `Playwright Server (${this._browser}) did not start within ${timeout}s. ` +
          `Log: ${logContent.slice(0, 500)}`
        );
      }

      // Check if server is responding on the external interface
      const checkCmd = `curl -sf http://${constants.GUEST_IP}:${this._guestPort}/json > /dev/null 2>&1 && echo ready || echo notready`;
      const result = await this.exec("sh", "-c", checkCmd);

      if (result.stdout.trim() === "ready") {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Ensure the server is started, starting it if needed.
   *
   * @param timeout - Timeout for start operation
   */
  private async _ensureStarted(timeout?: number): Promise<void> {
    if (!this._started) {
      await this.start(timeout);
    }
  }

  /**
   * Get the WebSocket endpoint for Playwright connect().
   *
   * This is the primary method to get the connection URL.
   * The returned URL can be used with Playwright's `connect()` method.
   *
   * @param timeout - Optional timeout to wait for server to start (starts automatically if not started)
   * @returns WebSocket endpoint URL (e.g., 'ws://localhost:3000/')
   *
   * @example
   * ```typescript
   * const box = new BrowserBox({ browser: 'chromium' });
   * const wsEndpoint = await box.wsEndpoint();
   * const browser = await chromium.connect(wsEndpoint);
   * ```
   */
  async wsEndpoint(timeout?: number): Promise<string> {
    await this._ensureStarted(timeout);
    return `ws://localhost:${this._hostPort}/`;
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
    const ws = await this.wsEndpoint(options?.timeout);

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
