/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException } from '@nestjs/common'
import { McpToolError, type ToolFailure } from './tool-error'

export function serviceError(error: unknown, operation: string): ToolFailure {
  if (error instanceof McpToolError) {
    return error.failure ?? { source: 'mcp', operation, code: 'tool_error', message: error.message.slice(0, 2048) }
  }
  if (!(error instanceof HttpException)) {
    return { source: 'service', operation, status: 500, code: 'internal_error', message: 'Tool operation failed' }
  }
  const status = error.getStatus()
  const response = error.getResponse()
  const fields = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {}
  const suppliedCode =
    typeof fields.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(fields.code) ? fields.code : undefined
  // Local 4xx exceptions deliberately target callers. External Runner bodies use a separate policy.
  const publicMessage =
    (status >= 400 && status < 500 && ![401, 403, 404].includes(status)) ||
    (status === 403 && fields.message === 'Organization is suspended') ||
    (status === 501 && suppliedCode === 'unsupported') ||
    (status === 503 && suppliedCode === 'upstream_unavailable')
  const value = typeof response === 'string' ? response : fields.message
  const message = Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.join('; ') : value
  const defaults: Record<number, [string, string]> = {
    400: ['invalid_argument', 'Invalid tool request'],
    401: ['unauthorized', 'Operation not permitted'],
    403: ['forbidden', 'Operation not permitted'],
    404: ['not_found', 'Resource not found or not accessible'],
    408: ['timeout', 'Operation timed out; its outcome may be uncertain'],
    409: ['conflict', 'Resource conflicts with this operation'],
    422: ['invalid_argument', 'Invalid tool request'],
    429: ['resource_exhausted', 'Too many requests'],
    501: ['unsupported', 'Operation is unavailable in this deployment'],
    503: ['upstream_unavailable', 'Service temporarily unavailable'],
    504: ['timeout', 'Operation timed out; its outcome may be uncertain'],
  }
  const [code, fallback] = defaults[status] ?? ['internal_error', 'Tool operation failed']
  const retry = (error as HttpException & { retryAfterSeconds?: unknown }).retryAfterSeconds
  const uncertain = status === 408 || status === 504
  const safeMessage =
    publicMessage && typeof message === 'string' && message.trim() && !/\p{Cc}/u.test(message.replace(/[\t\n]/g, ''))
      ? message.slice(0, 2048)
      : fallback
  return {
    source: 'service',
    operation,
    status,
    code: publicMessage ? (suppliedCode ?? code) : code,
    message: uncertain
      ? `${safeMessage.slice(0, 1950)} The operation may have started. Its outcome is unknown.`
      : safeMessage,
    ...(uncertain ? { outcome: 'unknown' as const } : {}),
    ...(publicMessage && typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
      ? { retry_after_seconds: retry }
      : {}),
  }
}
