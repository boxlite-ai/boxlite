/**
 * SimpleBox - Foundation for specialized container types.
 *
 * Provides common functionality for all specialized boxes (CodeBox, BrowserBox, etc.)
 * This class encapsulates common patterns:
 * 1. Automatic runtime lifecycle management
 * 2. Command execution with output collection
 * 3. Try/finally cleanup patterns
 */

import type { ExecResult } from './exec.js';
import { getJsBoxlite } from './native.js';

// Import types from native module (will be available after build)
type Boxlite = any;
type Box = any;
type Execution = any;
type BoxOptions = any;

/**
 * Security isolation options for a box.
 */
export interface SecurityOptions {
  /** Enable jailer isolation (Linux/macOS). */
  jailerEnabled?: boolean;

  /** Enable seccomp syscall filtering (Linux only). */
  seccompEnabled?: boolean;

  /**
   * Maximum number of open file descriptors.
   */
  maxOpenFiles?: number;

  /**
   * Maximum file size in bytes.
   */
  maxFileSize?: number;

  /**
   * Maximum number of processes.
   */
  maxProcesses?: number;

  /**
   * Maximum virtual memory in bytes.
   */
  maxMemory?: number;

  /**
   * Maximum CPU time in seconds.
   */
  maxCpuTime?: number;

  /** Enable network access in sandbox (macOS only). */
  networkEnabled?: boolean;

  /** Close inherited file descriptors. */
  closeFds?: boolean;
}

const MAX_SAFE_U64_NUMBER = Number.MAX_SAFE_INTEGER;

function normalizeU64Limit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid security option \`${field}\`: number must be finite`);
  }

  if (!Number.isInteger(value)) {
    throw new TypeError(`Invalid security option \`${field}\`: number must be an integer`);
  }

  if (value < 0) {
    throw new TypeError(`Invalid security option \`${field}\`: number must be >= 0`);
  }

  if (!Number.isSafeInteger(value) || value > MAX_SAFE_U64_NUMBER) {
    throw new TypeError(
      `Invalid security option \`${field}\`: number exceeds Number.MAX_SAFE_INTEGER`,
    );
  }

  return value;
}

function normalizeSecurityOptions(security: SecurityOptions | undefined): SecurityOptions | undefined {
  if (!security) {
    return undefined;
  }

  return {
    jailerEnabled: security.jailerEnabled,
    seccompEnabled: security.seccompEnabled,
    maxOpenFiles: normalizeU64Limit(security.maxOpenFiles, 'security.maxOpenFiles'),
    maxFileSize: normalizeU64Limit(security.maxFileSize, 'security.maxFileSize'),
    maxProcesses: normalizeU64Limit(security.maxProcesses, 'security.maxProcesses'),
    maxMemory: normalizeU64Limit(security.maxMemory, 'security.maxMemory'),
    maxCpuTime: normalizeU64Limit(security.maxCpuTime, 'security.maxCpuTime'),
    networkEnabled: security.networkEnabled,
    closeFds: security.closeFds,
  };
}

/**
 * Options for creating a SimpleBox.
 */
export interface SimpleBoxOptions {
  /** Container image to use (e.g., 'python:slim', 'alpine:latest') */
  image?: string;

  /** Path to local OCI layout directory (overrides image if provided) */
  rootfsPath?: string;

  /** Memory limit in MiB */
  memoryMib?: number;

  /** Number of CPU cores */
  cpus?: number;

  /** Disk size in GB for container rootfs (sparse, grows as needed) */
  diskSizeGb?: number;

  /** Optional runtime instance (uses global default if not provided) */
  runtime?: Boxlite;

  /** Optional name for the box (must be unique) */
  name?: string;

  /** Remove box when stopped (default: true) */
  autoRemove?: boolean;

  /** If true, reuse an existing box with the same name instead of failing (default: false) */
  reuseExisting?: boolean;

  /** Run box in detached mode (survives parent process exit, default: false) */
  detach?: boolean;

  /** Working directory inside container */
  workingDir?: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Volume mounts */
  volumes?: Array<{
    hostPath: string;
    guestPath: string;
    readOnly?: boolean;
  }>;

  /** Port mappings */
  ports?: Array<{
    hostPort?: number;
    guestPort: number;
    protocol?: string;
  }>;

  /**
   * Override image ENTRYPOINT directive.
   *
   * When set, completely replaces the image's ENTRYPOINT.
   * Use with `cmd` to build the full command:
   *   Final execution = entrypoint + cmd
   *
   * Example: For `docker:dind`, bypass the failing entrypoint script:
   *   `entrypoint: ["dockerd"]`, `cmd: ["--iptables=false"]`
   */
  entrypoint?: string[];

  /**
   * Override image CMD directive.
   *
   * The image ENTRYPOINT is preserved; these args replace the image's CMD.
   * Final execution = image_entrypoint + cmd.
   *
   * Example: For `docker:dind` (ENTRYPOINT=["dockerd-entrypoint.sh"]),
   * setting `cmd: ["--iptables=false"]` produces:
   * `["dockerd-entrypoint.sh", "--iptables=false"]`
   */
  cmd?: string[];

  /**
   * Override container user (UID/GID).
   *
   * Format: "uid", "uid:gid", or "username".
   * If not set, uses the image's USER directive (defaults to root "0:0").
   */
  user?: string;

  /** Security isolation options for the box. */
  security?: SecurityOptions;
}

/**
 * Base class for specialized container types.
 *
 * This class provides the foundation for all specialized boxes:
 * - CodeBox: Python code execution sandbox
 * - BrowserBox: Browser automation
 * - ComputerBox: Desktop automation
 * - InteractiveBox: PTY terminal sessions
 *
 * ## Usage
 *
 * SimpleBox can be used directly for simple command execution:
 *
 * ```typescript
 * const box = new SimpleBox({ image: 'alpine:latest' });
 * try {
 *   const result = await box.exec('ls', '-la', '/');
 *   console.log(result.stdout);
 * } finally {
 *   await box.stop();
 * }
 * ```
 *
 * Or extended for specialized use cases:
 *
 * ```typescript
 * class MyBox extends SimpleBox {
 *   constructor() {
 *     super({ image: 'my-custom-image:latest' });
 *   }
 *
 *   async myMethod() {
 *     const result = await this.exec('my-command');
 *     return result.stdout;
 *   }
 * }
 * ```
 */
export class SimpleBox {
  protected _runtime: Boxlite;
  protected _box: Box | null = null;
  protected _boxPromise: Promise<Box> | null = null;
  protected _name?: string;
  protected _boxOpts: BoxOptions;
  protected _reuseExisting: boolean;
  protected _created: boolean | null = null;

  /**
   * Create a new SimpleBox.
   *
   * The box is created lazily on first use (first exec() call).
   *
   * @param options - Box configuration options
   *
   * @example
   * ```typescript
   * const box = new SimpleBox({
   *   image: 'python:slim',
   *   memoryMib: 512,
   *   cpus: 2,
   *   name: 'my-box'
   * });
   * ```
   */
  constructor(options: SimpleBoxOptions = {}) {
    const JsBoxlite = getJsBoxlite();
    const security = normalizeSecurityOptions(options.security);

    // Use provided runtime or get global default
    if (options.runtime) {
      this._runtime = options.runtime;
    } else {
      this._runtime = JsBoxlite.withDefaultConfig();
    }

    // Convert options to BoxOptions format (stored for lazy creation)
    this._boxOpts = {
      image: options.image,
      rootfsPath: options.rootfsPath,
      cpus: options.cpus,
      memoryMib: options.memoryMib,
      diskSizeGb: options.diskSizeGb,
      autoRemove: options.autoRemove ?? true,
      detach: options.detach ?? false,
      workingDir: options.workingDir,
      env: options.env
        ? Object.entries(options.env).map(([key, value]) => ({ key, value }))
        : undefined,
      volumes: options.volumes,
      ports: options.ports,
      entrypoint: options.entrypoint,
      cmd: options.cmd,
      user: options.user,
      security,
    };

    this._name = options.name;
    this._reuseExisting = options.reuseExisting ?? false;
  }

  /**
   * Ensure the box is created (lazy initialization).
   * @internal
   */
  protected async _ensureBox(): Promise<Box> {
    if (this._box) {
      return this._box;
    }

    // Avoid race condition with concurrent calls
    if (!this._boxPromise) {
      this._boxPromise = (async () => {
        if (this._reuseExisting) {
          const result = await this._runtime.getOrCreate(this._boxOpts, this._name);
          this._created = result.created;
          return result.box;
        } else {
          this._created = true;
          return this._runtime.create(this._boxOpts, this._name);
        }
      })();
    }

    this._box = await this._boxPromise;
    return this._box;
  }

  /**
   * Get the box ID (ULID format).
   *
   * Note: Throws if called before the box is created (e.g., before first exec()).
   */
  get id(): string {
    if (!this._box) {
      throw new Error('Box not yet created. Call exec() first or use getId() async method.');
    }
    return this._box.id;
  }

  /**
   * Get the box ID asynchronously, creating the box if needed.
   */
  async getId(): Promise<string> {
    const box = await this._ensureBox();
    return box.id;
  }

  /**
   * Get the box name (if set).
   */
  get name(): string | undefined {
    return this._name;
  }

  /**
   * Whether this box was newly created (true) or an existing box was reused (false).
   *
   * Returns null if the box hasn't been created yet.
   */
  get created(): boolean | null {
    return this._created;
  }

  /**
   * Get box metadata.
   *
   * Note: Throws if called before the box is created.
   */
  info() {
    if (!this._box) {
      throw new Error('Box not yet created. Call exec() first.');
    }
    return this._box.info();
  }

  /**
   * Get box metadata asynchronously, creating the box if needed.
   */
  async getInfo() {
    const box = await this._ensureBox();
    return box.info();
  }

  /**
   * Execute a command in the box and collect the output.
   *
   * This is a convenience method that:
   * 1. Starts the command
   * 2. Collects all stdout and stderr
   * 3. Waits for completion
   * 4. Returns the result
   *
   * For streaming output, use the lower-level `this._box.exec()` directly.
   *
   * @param cmd - Command to execute (e.g., 'ls', 'python')
   * @param args - Arguments to the command
   * @param env - Environment variables (optional)
   *
   * @returns Promise resolving to ExecResult with exit code and output
   *
   * @example
   * ```typescript
   * // Simple execution
   * const result = await box.exec('ls', '-la', '/');
   * console.log(`Exit code: ${result.exitCode}`);
   * console.log(`Output:\n${result.stdout}`);
   *
   * // With environment variables
   * const result = await box.exec('env', [], { FOO: 'bar' });
   * console.log(result.stdout);
   * ```
   */
  async exec(cmd: string, ...args: string[]): Promise<ExecResult>;
  async exec(cmd: string, args: string[], env: Record<string, string>): Promise<ExecResult>;
  async exec(
    cmd: string,
    argsOrFirstArg?: string | string[],
    envOrSecondArg?: Record<string, string> | string,
    ...restArgs: string[]
  ): Promise<ExecResult> {
    // Parse overloaded arguments
    let args: string[];
    let env: Record<string, string> | undefined;

    if (Array.isArray(argsOrFirstArg)) {
      // exec(cmd, args[], env?)
      args = argsOrFirstArg;
      env = envOrSecondArg as Record<string, string> | undefined;
    } else {
      // exec(cmd, ...args, env?)
      // Collect all arguments
      const allArgs: any[] = [
        argsOrFirstArg,
        envOrSecondArg,
        ...restArgs,
      ].filter(a => a !== undefined);

      // Check if last arg is env object (before filtering to strings)
      const lastArg = allArgs[allArgs.length - 1];
      if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
        env = lastArg as Record<string, string>;
        args = allArgs.slice(0, -1).filter((a): a is string => typeof a === 'string');
      } else {
        env = undefined;
        args = allArgs.filter((a): a is string => typeof a === 'string');
      }
    }

    // Convert env to array of tuples
    const envArray = env
      ? Object.entries(env).map(([k, v]) => [k, v] as [string, string])
      : undefined;

    // Ensure box is created, then execute via Rust (returns Execution)
    const box = await this._ensureBox();
    const execution: Execution = await box.exec(cmd, args, envArray, false);

    // Collect stdout and stderr
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // Get streams
    let stdout;
    let stderr;

    try {
      stdout = await execution.stdout();
    } catch (err) {
      // Stream not available (expected for some commands)
      stdout = null;
    }

    try {
      stderr = await execution.stderr();
    } catch (err) {
      // Stream not available (expected for some commands)
      stderr = null;
    }

    // Read stdout
    if (stdout) {
      try {
        while (true) {
          const line = await stdout.next();
          if (line === null) break;
          stdoutLines.push(line);
        }
      } catch (err) {
        // Stream ended or error occurred
      }
    }

    // Read stderr
    if (stderr) {
      try {
        while (true) {
          const line = await stderr.next();
          if (line === null) break;
          stderrLines.push(line);
        }
      } catch (err) {
        // Stream ended or error occurred
      }
    }

    // Wait for completion
    const result = await execution.wait();

    return {
      exitCode: result.exitCode,
      stdout: stdoutLines.join(''),
      stderr: stderrLines.join(''),
    };
  }

  /**
   * Stop the box.
   *
   * Sends a graceful shutdown signal to the VM. If `autoRemove` is true
   * (default), the box files will be deleted after stopping.
   *
   * Does nothing if the box was never created.
   *
   * @example
   * ```typescript
   * await box.stop();
   * console.log('Box stopped');
   * ```
   */
  async stop(): Promise<void> {
    if (!this._box) {
      // Box was never created, nothing to stop
      return;
    }
    await this._box.stop();
  }

  /**
   * Implement async disposable pattern (TypeScript 5.2+).
   *
   * Allows using `await using` syntax for automatic cleanup:
   *
   * ```typescript
   * await using box = new SimpleBox({ image: 'alpine' });
   * // Box automatically stopped when leaving scope
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
