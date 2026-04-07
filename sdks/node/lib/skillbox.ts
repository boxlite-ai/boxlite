/**
 * SkillBox - Secure Claude Code CLI container.
 *
 * Provides an isolated environment for running Claude Code CLI with skills.
 */

import * as net from "node:net";
import {
  SimpleBox,
  type NetworkSpec,
  type Secret,
  type SimpleBoxOptions,
} from "./simplebox.js";
import { TimeoutError } from "./errors.js";
import {
  SKILLBOX_IMAGE,
  SKILLBOX_MEMORY_MIB,
  SKILLBOX_DISK_SIZE_GB,
  SKILLBOX_GUI_HTTP_PORT,
  SKILLBOX_GUI_HTTPS_PORT,
  COMPUTERBOX_DISPLAY_WIDTH,
  COMPUTERBOX_DISPLAY_HEIGHT,
  DESKTOP_READY_TIMEOUT,
  DESKTOP_READY_RETRY_DELAY,
} from "./constants.js";
import type {
  JsBoxlite,
  JsExecution,
  JsExecStdin,
  JsExecStdout,
} from "./native-contracts.js";

interface ClaudeContentItem {
  type?: string;
  text?: string;
}

interface ClaudeMessage {
  content?: ClaudeContentItem[];
}

interface ClaudeResponse {
  type?: string;
  session_id?: string;
  result?: string;
  message?: ClaudeMessage;
}

/**
 * Options for creating a SkillBox.
 */
export interface SkillBoxOptions {
  /** Skills to install on first call (e.g., ["anthropics/skills"]) */
  skills?: string[];
  /** Claude OAuth token. Uses CLAUDE_CODE_OAUTH_TOKEN env if not provided. */
  oauthToken?: string;
  /** Box name for persistence/reuse (default: "skill-box") */
  name?: string;
  /** Container image (default: boxlite-skillbox) */
  image?: string;
  /** Path to local OCI layout directory (overrides image if provided) */
  rootfsPath?: string;
  /** Memory allocation in MiB (default: 4096) */
  memoryMib?: number;
  /** Disk size in GB (default: 10) */
  diskSizeGb?: number;
  /** Local port for noVNC HTTP access (default: 0 for random) */
  guiHttpPort?: number;
  /** Local port for noVNC HTTPS access (default: 0 for random) */
  guiHttpsPort?: number;
  /** Remove box when stopped (default: true) */
  autoRemove?: boolean;
  /** Structured network configuration. */
  network?: NetworkSpec;
  /** Secrets to inject into outbound HTTPS requests. */
  secrets?: Secret[];
  /** Optional runtime instance */
  runtime?: JsBoxlite;
}

function findAvailablePort(start = 10000, end = 65535): Promise<number> {
  const ports = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  // Shuffle and try up to 100
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }
  const candidates = ports.slice(0, 100);

  return new Promise((resolve, reject) => {
    let idx = 0;
    function tryNext() {
      if (idx >= candidates.length) {
        reject(
          new Error(
            `Could not find an available port in range ${start}-${end}`,
          ),
        );
        return;
      }
      const port = candidates[idx++];
      const server = net.createServer();
      server.once("error", () => tryNext());
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    }
    tryNext();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Secure container for running Claude Code CLI with skills.
 *
 * SkillBox provides an isolated environment for Claude Code CLI
 * with user-specified skills installed. It supports multi-turn conversations
 * and includes a desktop GUI accessible via noVNC.
 *
 * @example
 * ```typescript
 * const box = new SkillBox({ skills: ["anthropics/skills"] });
 * try {
 *   await box.start();
 *   const result = await box.call("What skills do you have?");
 *   console.log(result);
 * } finally {
 *   await box.stop();
 * }
 * ```
 */
export class SkillBox extends SimpleBox {
  private _skills: string[];
  private _oauthToken: string;
  private _process: JsExecution | null = null;
  private _stdin: JsExecStdin | null = null;
  private _stdout: JsExecStdout | null = null;
  private _sessionId: string = "default";
  private _setupComplete: boolean = false;
  private _started: boolean = false;

  /** Local port for noVNC HTTP access */
  guiHttpPort: number;
  /** Local port for noVNC HTTPS access */
  guiHttpsPort: number;

  private _skillboxEnv: Record<string, string> = {
    DISPLAY: ":1",
  };

  constructor(options: SkillBoxOptions = {}) {
    // Build image args
    const imageOpts: Partial<SimpleBoxOptions> = {};
    if (options.rootfsPath) {
      imageOpts.rootfsPath = options.rootfsPath;
    } else {
      imageOpts.image = options.image ?? SKILLBOX_IMAGE;
    }

    const oauthToken =
      options.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";

    super({
      ...imageOpts,
      memoryMib: options.memoryMib ?? SKILLBOX_MEMORY_MIB,
      diskSizeGb: options.diskSizeGb ?? SKILLBOX_DISK_SIZE_GB,
      name: options.name ?? "skill-box",
      autoRemove: options.autoRemove ?? true,
      network: options.network,
      secrets: options.secrets,
      runtime: options.runtime,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        DISPLAY: ":1",
        DISPLAY_SIZEW: String(COMPUTERBOX_DISPLAY_WIDTH),
        DISPLAY_SIZEH: String(COMPUTERBOX_DISPLAY_HEIGHT),
        SELKIES_MANUAL_WIDTH: String(COMPUTERBOX_DISPLAY_WIDTH),
        SELKIES_MANUAL_HEIGHT: String(COMPUTERBOX_DISPLAY_HEIGHT),
        SELKIES_UI_SHOW_SIDEBAR: "false",
      },
      ports: [],
    });

    this._skills = options.skills ?? [];
    this._oauthToken = oauthToken;
    this.guiHttpPort = options.guiHttpPort ?? 0;
    this.guiHttpsPort = options.guiHttpsPort ?? 0;
  }

  /**
   * Start the SkillBox (resolves ports and creates the box).
   */
  async start(): Promise<void> {
    if (!this._oauthToken) {
      throw new Error(
        "OAuth token required. Set CLAUDE_CODE_OAUTH_TOKEN env var " +
          "or pass oauthToken parameter.",
      );
    }

    // Resolve ports
    if (this.guiHttpPort === 0) {
      this.guiHttpPort = await findAvailablePort();
    }
    if (this.guiHttpsPort === 0) {
      this.guiHttpsPort = await findAvailablePort();
    }
    if (this.guiHttpPort === this.guiHttpsPort) {
      this.guiHttpsPort = await findAvailablePort();
    }

    // Patch port mappings before box creation
    this._boxOpts.ports = [
      { hostPort: this.guiHttpPort, guestPort: SKILLBOX_GUI_HTTP_PORT },
      { hostPort: this.guiHttpsPort, guestPort: SKILLBOX_GUI_HTTPS_PORT },
    ];

    await this._ensureBox();
    this._started = true;
  }

  /**
   * Stop the SkillBox and clean up Claude process.
   */
  async stop(): Promise<void> {
    await this._stopClaude();
    this._started = false;
    await super.stop();
  }

  /**
   * Wait until the desktop environment is fully loaded and ready.
   *
   * @param timeout - Maximum time to wait in seconds (default: 60)
   */
  async waitUntilReady(timeout: number = DESKTOP_READY_TIMEOUT): Promise<void> {
    const startMs = Date.now();
    const expectedSize = `${COMPUTERBOX_DISPLAY_WIDTH}x${COMPUTERBOX_DISPLAY_HEIGHT}`;

    while (true) {
      const elapsed = (Date.now() - startMs) / 1000;
      if (elapsed > timeout) {
        throw new TimeoutError(
          `Desktop did not become ready within ${timeout} seconds`,
        );
      }

      try {
        const result = await SimpleBox.prototype.exec.call(
          this,
          "xwininfo",
          ["-tree", "-root"],
          this._skillboxEnv,
        );

        if (
          result.stdout.includes("xfdesktop") &&
          result.stdout.includes(expectedSize)
        ) {
          return;
        }
      } catch {
        // Not ready yet
      }

      await sleep(DESKTOP_READY_RETRY_DELAY * 1000);
    }
  }

  /**
   * Send a prompt to Claude and return the response.
   *
   * Supports multi-turn conversations within the same session.
   * On first call, installs dependencies if not already installed.
   *
   * @param prompt - The message to send to Claude
   * @returns Claude's response text
   */
  async call(prompt: string): Promise<string> {
    if (!this._started) {
      throw new Error("SkillBox not started. Call start() first.");
    }

    if (!this._setupComplete) {
      await this._setup();
      this._setupComplete = true;
    }

    if (!this._stdin || !this._stdout) {
      await this._startClaude();
    }

    const [responseText, newSessionId] = await this._sendMessage(prompt);
    this._sessionId = newSessionId;
    return responseText;
  }

  /**
   * Install a skill from skills.sh.
   *
   * @param skillId - Skill identifier (owner/repo format)
   * @returns True if installation succeeded
   */
  async installSkill(skillId: string): Promise<boolean> {
    if (!this._started) {
      throw new Error("SkillBox not started. Call start() first.");
    }

    if (!this._setupComplete) {
      await this._setup();
      this._setupComplete = true;
    }

    return this._installSkillInternal(skillId);
  }

  private async _setup(): Promise<void> {
    if (!(await this._isClaudeInstalled())) {
      await this._installDependencies();
    }

    for (const skillId of this._skills) {
      await this._installSkillInternal(skillId);
    }
  }

  private async _isClaudeInstalled(): Promise<boolean> {
    try {
      const result = await SimpleBox.prototype.exec.call(
        this,
        "claude",
        ["--version"],
        this._skillboxEnv,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async _installDependencies(): Promise<void> {
    const run = (cmd: string, args: string[]) =>
      SimpleBox.prototype.exec.call(this, cmd, args, this._skillboxEnv);

    await run("apt-get", ["update"]);

    const installResult = await run("bash", [
      "-c",
      "curl -fsSL https://claude.ai/install.sh | bash",
    ]);
    if (installResult.exitCode !== 0) {
      throw new Error(`Failed to install Claude CLI: ${installResult.stderr}`);
    }

    const bashResult = await run("apt-get", ["install", "-y", "bash"]);
    if (bashResult.exitCode !== 0) {
      throw new Error(`Failed to install bash: ${bashResult.stderr}`);
    }

    const gitResult = await run("apt-get", ["install", "-y", "git"]);
    if (gitResult.exitCode !== 0) {
      throw new Error(`Failed to install git: ${gitResult.stderr}`);
    }

    const pyResult = await run("apt-get", [
      "install",
      "-y",
      "python3",
      "python3-pip",
    ]);
    if (pyResult.exitCode !== 0) {
      throw new Error(`Failed to install Python: ${pyResult.stderr}`);
    }

    await run("/config/.local/bin/claude", ["--version"]);
  }

  private async _installSkillInternal(skillId: string): Promise<boolean> {
    const result = await SimpleBox.prototype.exec.call(
      this,
      "npx",
      ["add-skill", skillId, "-y", "--agent", "claude-code"],
      this._skillboxEnv,
    );
    return result.exitCode === 0;
  }

  private async _startClaude(): Promise<void> {
    const box = await this._ensureBox();
    this._process = await box.exec(
      "claude",
      [
        "--dangerously-skip-permissions",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--mcp-config",
        "/config/.claude.json",
        "--verbose",
      ],
      [
        ["CLAUDE_CODE_OAUTH_TOKEN", this._oauthToken],
        ["IS_SANDBOX", "1"],
        ["SHELL", "/bin/bash"],
        ["DISPLAY", ":1"],
      ],
      false,
    );
    this._stdin = await this._process.stdin();
    this._stdout = await this._process.stdout();
  }

  private async _stopClaude(): Promise<void> {
    if (this._stdin) {
      try {
        await this._stdin.close();
      } catch {
        // Ignore close errors
      }
      this._stdin = null;
    }

    if (this._process) {
      try {
        await this._process.wait();
      } catch {
        // Ignore wait errors
      }
      this._process = null;
    }

    this._stdout = null;
  }

  private async _sendMessage(content: string): Promise<[string, string]> {
    const stdin = this._stdin;
    const stdout = this._stdout;

    if (!stdin || !stdout) {
      throw new Error("Claude process is not running");
    }

    const msg = {
      type: "user",
      message: { role: "user", content },
      session_id: this._sessionId,
      parent_tool_use_id: null,
    };

    const payload = JSON.stringify(msg) + "\n";
    await stdin.writeString(payload);

    const responses: ClaudeResponse[] = [];
    let newSessionId = this._sessionId;
    let buffer = "";
    let done = false;

    try {
      while (!done) {
        const chunk: string | null = await Promise.race([
          stdout.next(),
          sleep(120_000).then(() => {
            throw new TimeoutError("Timeout waiting for Claude response");
          }),
        ]);

        if (chunk === null) break;
        buffer += chunk;

        while (buffer.includes("\n")) {
          const nlIdx = buffer.indexOf("\n");
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);

          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as unknown;
            if (typeof parsed !== "object" || parsed === null) {
              continue;
            }

            const response = parsed as ClaudeResponse;
            responses.push(response);

            if (response.session_id) {
              newSessionId = response.session_id;
            }

            if (response.type === "result") {
              done = true;
              break;
            }
          } catch {
            // JSON parse error, skip
          }
        }
      }
    } catch (err) {
      if (!(err instanceof TimeoutError)) {
        // Stream ended
      }
    }

    // Extract response text
    const resultMsg = responses.find((r) => r.type === "result");
    let responseText = "";

    if (resultMsg) {
      responseText = resultMsg.result ?? "";
    } else {
      for (const r of responses) {
        if (r.type === "assistant") {
          const contentList = r.message?.content ?? [];
          for (const item of contentList) {
            if (item.type === "text" && item.text) {
              responseText = item.text;
              break;
            }
          }
          if (responseText) break;
        }
      }
    }

    return [responseText, newSessionId];
  }
}
