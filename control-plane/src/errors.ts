/** Error with the contracts §1 body shape: {"error": {code, message, next, ...details}}. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly next?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** Every body carries a `next`: the one given at the throw, else the code's default. */
  toBody(): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...this.details, next: this.next || defaultNext(this.code) } };
  }
}

/**
 * What to do about an error of this code when the throw site gave nothing more specific. The
 * console and raw API callers read these as they are; the CLI may replace a missing or generic
 * one with a hint that names the exact command line.
 */
const NEXT_BY_CODE: Record<string, string> = {
  unauthenticated: 'send the App key as `Authorization: Bearer <App key>`; `boxlite-app whoami` checks the key you have',
  not_found_app: '`boxlite-app whoami` shows which App this key belongs to',
  not_found_env: '`boxlite-app app status` lists the environments',
  not_found: '`boxlite-app app status` shows what this App has',
  forbidden: '`boxlite-app whoami` shows what this App key may do',
  write_requires_flag: 'rerun with --write once you have checked the statement',
  unavailable: 'wait 30 s and rerun (at most 3 times); `boxlite-app doctor` checks the connection',
  invalid_manifest: '`boxlite-app check` lists every problem in boxlite.toml with its line',
  deploy_failed: '`boxlite-app app deployments` lists the deployments; `boxlite-app app deployment <N> --logs` shows why one failed',
  stale_base: '`boxlite-app app pull` brings boxlite.toml up to date; review the diff, then rerun',
  not_supported_yet: 'remove that setting; `boxlite-app docs manifest` lists what is supported',
  conflict: '`boxlite-app app deployments` shows what is running; wait for it with `boxlite-app app deployment <N> --follow`',
  rate_limited: 'wait the Retry-After seconds, then rerun',
  sql_error: 'fix the SQL and rerun; `boxlite-app app db schema` lists tables and columns',
  invalid_request: '`boxlite-app docs reference` lists every command and what it sends',
};

export function defaultNext(code: string): string {
  return NEXT_BY_CODE[code] ?? '`boxlite-app doctor` checks the app and the platform';
}

const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  not_found_app: 404,
  not_found_env: 404,
  not_found: 404,
  forbidden: 403,
  write_requires_flag: 403,
  unavailable: 503,
  invalid_manifest: 422,
  deploy_failed: 409,
  stale_base: 409,
  not_supported_yet: 422,
  conflict: 409,
  rate_limited: 429,
  /** The App's SMTP server refused or did not answer (enduser/email-sender.ts). */
  smtp_error: 502,
};

/** Build an HttpError whose HTTP status follows from the code. */
export function fail(code: string, message: string, next?: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(STATUS_BY_CODE[code] ?? 400, code, message, next, details);
}

/** Upstream (BoxLite/Neon/supervisor) failure; keeps the upstream status for diagnosis, never the request. */
export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(`${service}: ${message}`);
    this.name = 'UpstreamError';
  }
}
