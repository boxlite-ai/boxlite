/** Error with the contracts §1 body shape: {"error": {code, message, next?, ...details}}. */
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

  toBody(): { error: Record<string, unknown> } {
    const error: Record<string, unknown> = { code: this.code, message: this.message, ...this.details };
    if (this.next) error.next = this.next;
    return { error };
  }
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
