/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubRequestError, githubRetryAt, readGitHubBody } from './github'
import { object } from './execution/model'

type PollReason =
  | 'transport'
  | 'timeout'
  | 'http'
  | 'response-read'
  | 'response-json'
  | 'message-id'
  | 'message-type'
  | 'message-body'
  | 'event-type'
  | 'job-request-id'
  | 'job-available'
  | 'statistics'
  | 'token-refresh'
  | 'poll-arguments'

export class PollMessageError extends Error {
  readonly valueType: string
  constructor(
    readonly field: PollReason,
    value: unknown,
  ) {
    super(field)
    this.valueType =
      value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  }
}

const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** Report selected response fields only. GitHub messages can interpolate repository names, URLs and credentials. */
export async function githubPollMessage(response: Response): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readGitHubBody(response, 8192))
    if (!object(data) || typeof data.message !== 'string') return undefined
    if (/^API rate limit exceeded\b/i.test(data.message)) return 'API rate limit exceeded'
    if (/secondary rate limit/i.test(data.message)) return 'Secondary rate limit exceeded'
    if (['Bad credentials', 'Not Found', 'Resource not accessible by integration'].includes(data.message))
      return data.message
  } catch {
    /* A missing or unreadable error body does not change the observed status. */
  }
  return undefined
}

export class ScaleSetPollError extends GitHubRequestError {
  readonly details: {
    reason: PollReason
    githubRequestId?: string
    retryAfterSeconds?: number
    rateLimitRemaining?: number
    rateLimitResetAt?: number
    githubMessage?: string
    transportCode?: string
    valueType?: string
  }
  constructor(reason: PollReason, response?: Response, cause?: unknown, githubMessage?: string) {
    super(
      response?.status ?? (cause instanceof GitHubRequestError ? cause.status : undefined),
      false,
      response ? githubRetryAt(response) : cause instanceof GitHubRequestError ? cause.retryAt : undefined,
    )
    this.details = { reason }
    if (cause instanceof PollMessageError) this.details.valueType = cause.valueType
    const headers = response?.headers
    const requestId = headers?.get('x-github-request-id') ?? headers?.get('x-vss-e2eid')
    if (
      requestId &&
      /^(?:[a-f\d]{1,16}:){2,5}[a-f\d]{1,16}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId)
    )
      this.details.githubRequestId = requestId
    const after = headers?.get('retry-after'),
      remaining = headers?.get('x-ratelimit-remaining'),
      reset = headers?.get('x-ratelimit-reset')
    if (after && /^\d{1,10}$/.test(after)) this.details.retryAfterSeconds = Number(after)
    if (remaining && /^\d{1,12}$/.test(remaining)) this.details.rateLimitRemaining = Number(remaining)
    if (reset && /^\d{1,12}$/.test(reset)) this.details.rateLimitResetAt = Number(reset) * 1000
    if (githubMessage) this.details.githubMessage = githubMessage
    const nested = object(cause) ? cause.cause : undefined
    const code = object(nested) ? nested.code : object(cause) ? cause.code : undefined
    if (typeof code === 'string' && networkCodes.has(code)) this.details.transportCode = code
  }
}
