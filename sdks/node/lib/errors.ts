/**
 * Base error class for all BoxLite-related errors.
 *
 * All BoxLite errors inherit from this class, allowing easy error type checking:
 * ```typescript
 * try {
 *   await box.exec('invalid-command');
 * } catch (err) {
 *   if (err instanceof BoxliteError) {
 *     console.error('BoxLite error:', err.message);
 *   }
 * }
 * ```
 */
export class BoxliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxliteError";
    // Maintain proper stack trace for where our error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BoxliteError);
    }
  }
}

/**
 * Execution error thrown when a command fails (non-zero exit code).
 *
 * Contains details about the failed command, exit code, and stderr output.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await box.exec('false');
 * } catch (err) {
 *   if (err instanceof ExecError) {
 *     console.error(`Command '${err.command}' failed with exit code ${err.exitCode}`);
 *     console.error(`Stderr: ${err.stderr}`);
 *   }
 * }
 * ```
 */
export class ExecError extends BoxliteError {
  /**
   * @param command - The command that failed
   * @param exitCode - The non-zero exit code
   * @param stderr - Standard error output
   */
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`Command '${command}' failed with exit code ${exitCode}: ${stderr}`);
    this.name = "ExecError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ExecError);
    }
  }
}

/**
 * Timeout error thrown when an operation exceeds its time limit.
 *
 * @example
 * ```typescript
 * try {
 *   await waitForDesktopReady(box, 60); // 60 second timeout
 * } catch (err) {
 *   if (err instanceof TimeoutError) {
 *     console.error('Operation timed out:', err.message);
 *   }
 * }
 * ```
 */
export class TimeoutError extends BoxliteError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}

/**
 * Parse error thrown when unable to parse command output.
 *
 * Used when parsing structured output (JSON, coordinates, etc.) fails.
 *
 * @example
 * ```typescript
 * try {
 *   const position = parseCursorPosition(output);
 * } catch (err) {
 *   if (err instanceof ParseError) {
 *     console.error('Failed to parse output:', err.message);
 *   }
 * }
 * ```
 */
export class ParseError extends BoxliteError {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ParseError);
    }
  }
}

/**
 * The machine code of a failure the native runtime reported: the code
 * `BoxliteError::http()` (src/shared/src/errors.rs) gives it, which is also
 * the code a REST server answers the same failure with.
 */
export type BoxliteErrorCode =
  | "invalid_argument"
  | "unsupported"
  | "not_found"
  | "session_reaped"
  | "already_exists"
  | "invalid_state"
  | "stopped"
  | "image_pull_failed"
  | "execution_failed"
  | "resource_exhausted"
  | "network_unavailable"
  | "upstream_unavailable"
  | "engine_unavailable"
  | "storage_error"
  | "database_error"
  | "metadata_error"
  | "config_error"
  | "internal";

// The binding throws a failure with its Display text as the message. An async
// rejection from napi cannot carry a code of its own, so the code is read back
// off the prefix each variant's Display starts with.
const DISPLAY_PREFIXES: ReadonlyArray<readonly [string, BoxliteErrorCode]> = [
  ["unsupported engine kind", "unsupported"],
  ["unsupported: ", "unsupported"],
  ["engine reported an error: ", "engine_unavailable"],
  ["configuration error: ", "config_error"],
  ["storage error: ", "storage_error"],
  ["images error: ", "image_pull_failed"],
  ["portal error: ", "upstream_unavailable"],
  ["network error: ", "network_unavailable"],
  ["gRPC/tonic error: ", "upstream_unavailable"],
  ["gRPC transport error: ", "upstream_unavailable"],
  ["internal error: ", "internal"],
  ["Execution error: ", "execution_failed"],
  ["not found: ", "not_found"],
  ["already exists: ", "already_exists"],
  ["invalid state: ", "invalid_state"],
  ["database error: ", "database_error"],
  ["metadata error: ", "metadata_error"],
  ["invalid argument: ", "invalid_argument"],
  ["stopped: ", "stopped"],
  ["resource exhausted: ", "resource_exhausted"],
  ["session reaped: ", "session_reaped"],
];

/**
 * The code of a failure the native runtime reported, or `undefined` for any
 * other error.
 *
 * ```typescript
 * try {
 *   await runtime.remove('no-such-box');
 * } catch (err) {
 *   if (errorCode(err) === 'not_found') {
 *     // nothing to remove
 *   }
 * }
 * ```
 */
export function errorCode(err: unknown): BoxliteErrorCode | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  return DISPLAY_PREFIXES.find(([prefix]) =>
    err.message.startsWith(prefix),
  )?.[1];
}
