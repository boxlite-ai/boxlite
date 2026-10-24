/** Error codes of contracts §1 and the process exit code each maps to. Anything else exits 1. */
export const ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  unauthenticated: 2,
  not_found_app: 3,
  not_found_env: 3,
  not_found: 4,
  forbidden: 5,
  write_requires_flag: 5, // add --write; nothing ran
  unavailable: 6,
  rate_limited: 6, // retryable: the CLI already waited Retry-After three times
  invalid_manifest: 7,
  deploy_failed: 8,
  stale_base: 9,
  confirmation_required: 10,
};

export function exitCodeFor(code: string): number {
  return ERROR_EXIT_CODES[code] ?? 1;
}

export interface ErrorBody {
  code: string;
  message: string;
  next?: string;
  [extra: string]: unknown;
}

export class MicrocloudError extends Error {
  readonly code: string;
  readonly next: string | undefined;
  readonly exit: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, next?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MicrocloudError';
    this.code = code;
    this.next = next;
    this.exit = exitCodeFor(code);
    this.details = details;
  }

  toBody(): { error: ErrorBody } {
    const error: ErrorBody = { code: this.code, message: this.message, ...this.details };
    if (this.next) error.next = this.next;
    return { error };
  }
}
