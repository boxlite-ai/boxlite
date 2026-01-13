/**
 * InteractiveBox - Interactive terminal sessions with PTY support.
 *
 * Provides automatic PTY-based interactive sessions, similar to `docker exec -it`.
 */

import { SimpleBox, SimpleBoxOptions } from './simplebox.js';

// Import types from native module (will be available after build)
type Execution = any;

/**
 * Options for creating an InteractiveBox.
 */
export interface InteractiveBoxOptions extends SimpleBoxOptions {
  /** Shell to run (default: '/bin/sh') */
  shell?: string;

  /**
   * Control terminal I/O forwarding behavior:
   * - undefined (default): Auto-detect - forward I/O if stdin is a TTY
   * - true: Force I/O forwarding (manual interactive mode)
   * - false: No I/O forwarding (programmatic control only)
   */
  tty?: boolean;
}

/**
 * Interactive box with automatic PTY and terminal forwarding.
 *
 * When used as a context manager, automatically:
 * 1. Auto-detects terminal size (like Docker)
 * 2. Starts a shell with PTY
 * 3. Sets local terminal to raw mode
 * 4. Forwards stdin/stdout bidirectionally
 * 5. Restores terminal mode on exit
 *
 * ## Example
 *
 * ```typescript
 * const box = new InteractiveBox({ image: 'alpine:latest' });
 * try {
 *   await box.start();
 *   // You're now in an interactive shell!
 *   // Type commands, see output in real-time
 *   // Type "exit" to close
 *   await box.wait();
 * } finally {
 *   await box.stop();
 * }
 * ```
 *
 * Or with async disposal (TypeScript 5.2+):
 *
 * ```typescript
 * await using box = new InteractiveBox({ image: 'alpine:latest' });
 * await box.start();
 * await box.wait();
 * // Automatically stopped when leaving scope
 * ```
 */
export class InteractiveBox extends SimpleBox {
  // InteractiveBox-specific state (inherited: _runtime, _box, _boxOpts from SimpleBox)
  protected _shell: string;
  protected _interactiveEnv?: Record<string, string>;
  protected _tty: boolean;
  protected _execution?: Execution;
  protected _stdin?: any;
  protected _stdout?: any;
  protected _stderr?: any;
  protected _ioTasks: Promise<void>[] = [];
  protected _exited: boolean = false;

  /**
   * Create an interactive box.
   *
   * @param options - InteractiveBox configuration options
   *
   * @example
   * ```typescript
   * const box = new InteractiveBox({
   *   image: 'alpine:latest',
   *   shell: '/bin/sh',
   *   tty: true,
   *   memoryMib: 512,
   *   cpus: 1
   * });
   * ```
   */
  constructor(options: InteractiveBoxOptions) {
    // Extract InteractiveBox-specific options before passing to parent
    const { shell = '/bin/sh', tty, ...baseOptions } = options;

    // Call parent constructor (handles runtime, lazy box creation)
    super(baseOptions);

    // InteractiveBox-specific initialization
    this._shell = shell;
    this._interactiveEnv = options.env;

    // Determine TTY mode: undefined = auto-detect, true = force, false = disable
    this._tty = tty === undefined ? (process.stdin.isTTY ?? false) : tty;
  }

  // id getter inherited from SimpleBox

  /**
   * Start the interactive shell session.
   *
   * This method:
   * 1. Starts the shell with PTY
   * 2. Sets terminal to raw mode (if tty=true)
   * 3. Begins I/O forwarding
   *
   * @example
   * ```typescript
   * await box.start();
   * ```
   */
  async start(): Promise<void> {
    // Ensure box is created (inherited from SimpleBox)
    const box = await this._ensureBox();

    // Convert env to array format if provided
    const envArray = this._interactiveEnv
      ? Object.entries(this._interactiveEnv).map(([k, v]) => [k, v] as [string, string])
      : undefined;

    // Start shell with PTY (box.exec runs command inside container, not on host)
    this._execution = await box.exec(this._shell, [], envArray, true);

    // Get streams (these are async in Rust, must await)
    try {
      this._stdin = await this._execution.stdin();
    } catch (err) {
      // stdin not available
    }

    try {
      this._stdout = await this._execution.stdout();
    } catch (err) {
      // stdout not available
    }

    try {
      this._stderr = await this._execution.stderr();
    } catch (err) {
      // stderr not available
    }

    // Only set raw mode and start forwarding if tty=true
    if (this._tty && process.stdin.isTTY) {
      // Set terminal to raw mode
      process.stdin.setRawMode(true);
      process.stdin.resume();

      // Start bidirectional I/O forwarding
      this._ioTasks.push(
        this._forwardStdin(),
        this._forwardOutput(),
        this._forwardStderr(),
        this._waitForExit()
      );
    } else {
      // No I/O forwarding, just wait for execution
      this._ioTasks.push(this._waitForExit());
    }
  }

  /**
   * Wait for the shell to exit.
   *
   * @example
   * ```typescript
   * await box.start();
   * await box.wait();  // Blocks until shell exits
   * ```
   */
  async wait(): Promise<void> {
    await Promise.all(this._ioTasks);
  }

  /**
   * Stop the box and restore terminal settings.
   *
   * @example
   * ```typescript
   * await box.stop();
   * ```
   */
  async stop(): Promise<void> {
    // 1. Restore terminal settings (InteractiveBox-specific cleanup)
    if (this._tty && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch (err) {
        // Ignore errors during cleanup
      }
    }

    // 2. Wait for I/O tasks to complete (with timeout)
    if (this._ioTasks.length > 0) {
      try {
        await Promise.race([
          Promise.all(this._ioTasks),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
        ]);
      } catch (err) {
        // Timeout or error - continue with shutdown
      }
      this._ioTasks = [];  // Clear tasks
    }

    // 3. Call parent's stop() to shut down the box
    await super.stop();
  }

  /**
   * Implement async disposable pattern (TypeScript 5.2+).
   *
   * Allows using `await using` syntax for automatic cleanup.
   *
   * @example
   * ```typescript
   * await using box = new InteractiveBox({ image: 'alpine' });
   * await box.start();
   * // Box automatically stopped when leaving scope
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  /**
   * Forward stdin to PTY (internal).
   */
  private async _forwardStdin(): Promise<void> {
    if (!this._stdin) return;

    try {
      process.stdin.on('data', async (data: Buffer) => {
        if (!this._exited && this._stdin) {
          try {
            await this._stdin.write(data);
          } catch (err) {
            // Ignore write errors (box may be shutting down)
          }
        }
      });

      // Wait for exit
      await new Promise<void>((resolve) => {
        const checkExit = setInterval(() => {
          if (this._exited) {
            clearInterval(checkExit);
            resolve();
          }
        }, 100);
      });
    } catch (err) {
      // Ignore errors during shutdown
    }
  }

  /**
   * Forward PTY output to stdout (internal).
   */
  private async _forwardOutput(): Promise<void> {
    if (!this._stdout) return;

    try {
      while (true) {
        const chunk = await this._stdout.next();
        if (chunk === null) break;

        // Write to stdout
        if (typeof chunk === 'string') {
          process.stdout.write(chunk);
        } else {
          process.stdout.write(chunk);
        }
      }
    } catch (err) {
      // Stream ended or error
    }
  }

  /**
   * Forward PTY stderr to stderr (internal).
   */
  private async _forwardStderr(): Promise<void> {
    if (!this._stderr) return;

    try {
      while (true) {
        const chunk = await this._stderr.next();
        if (chunk === null) break;

        // Write to stderr
        if (typeof chunk === 'string') {
          process.stderr.write(chunk);
        } else {
          process.stderr.write(chunk);
        }
      }
    } catch (err) {
      // Stream ended or error
    }
  }

  /**
   * Wait for the shell to exit (internal).
   */
  private async _waitForExit(): Promise<void> {
    try {
      if (this._execution) {
        await this._execution.wait();
      }
    } catch (err) {
      // Ignore errors during shutdown
    } finally {
      this._exited = true;
    }
  }
}
