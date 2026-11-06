/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { join } from 'node:path'
import { STATUS_CODES } from 'node:http'
import { Request, Response } from 'express'
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'

const ADMIN_ERRORS: Record<number, [string, string]> = {
  400: ['InvalidArgumentError', 'invalid_argument'],
  401: ['AuthError', 'unauthenticated'],
  403: ['AuthError', 'permission_denied'],
  404: ['NotFoundError', 'not_found'],
  409: ['InvalidStateError', 'invalid_state'],
  422: ['InvalidArgumentError', 'invalid_argument'],
  429: ['ResourceExhaustedError', 'resource_exhausted'],
  502: ['UpstreamUnavailableError', 'upstream_unavailable'],
  503: ['UpstreamUnavailableError', 'upstream_unavailable'],
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  constructor(private readonly failedAuthTracker: FailedAuthTrackerService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()
    const isAdminApi = /^\/(?:api\/)?v1\/organizations(?:\/|$)/.test(request.path)

    let statusCode: number
    let error: string
    let message: string
    let code: string | undefined
    let boxId: string | undefined
    // Image progress is forwarded rather than
    // flattened because it is the same shape a successful box response
    // publishes, and a caller that parses one should not need a second parser.
    let progress: Record<string, unknown> | undefined

    // A NotFoundException outside the API serves the dashboard, which routes on
    // the client. `/.well-known/` documents are machine-read (RFC 9728 metadata,
    // for one), so a missing one stays a 404 rather than a 200 HTML page.
    const servesDashboard = !request.path.startsWith('/api/') && !request.path.startsWith('/.well-known/')
    if (exception instanceof NotFoundException && servesDashboard && !isAdminApi) {
      const response = ctx.getResponse()
      response.sendFile(join(__dirname, '..', 'dashboard', 'index.html'))
      return
    }

    // Track failed authentication attempts
    if (exception instanceof UnauthorizedException) {
      try {
        await this.failedAuthTracker.incrementFailedAuth(request, response)
      } catch (trackingError) {
        if (trackingError instanceof ThrottlerException) {
          exception = trackingError
        } else {
          this.logger.error('Failed to track authentication failure:', trackingError)
        }
      }
    }

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus()
      error = STATUS_CODES[statusCode]
      const exceptionResponse = exception.getResponse()
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse
      } else {
        const responseMessage = (exceptionResponse as Record<string, unknown>).message
        message = Array.isArray(responseMessage)
          ? responseMessage.join(', ')
          : (responseMessage as string) || exception.message
        const responseCode = (exceptionResponse as Record<string, unknown>).code
        code = typeof responseCode === 'string' ? responseCode : undefined
        const responseBoxId = (exceptionResponse as Record<string, unknown>).boxId
        boxId = typeof responseBoxId === 'string' && responseBoxId.length > 0 ? responseBoxId : undefined
        const responseProgress = (exceptionResponse as Record<string, unknown>).progress
        progress =
          typeof responseProgress === 'object' && responseProgress !== null && !Array.isArray(responseProgress)
            ? (responseProgress as Record<string, unknown>)
            : undefined
      }

      const retryAfterSeconds = (exception as { retryAfterSeconds?: unknown }).retryAfterSeconds
      if (typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
        response.setHeader('Retry-After', retryAfterSeconds.toString())
      }
    } else {
      this.logger.error(exception)
      error = STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR]
      message = 'An unexpected error occurred.'
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR
    }

    if (isAdminApi) {
      const [type, code] = ADMIN_ERRORS[statusCode] ?? ['InternalError', 'internal']
      const requestId = response.getHeader('X-Request-Id')
      response
        .status(statusCode)
        .json({ error: { message, type, code, ...(typeof requestId === 'string' ? { request_id: requestId } : {}) } })
      return
    }

    response.status(statusCode).json({
      path: request.url,
      timestamp: new Date().toISOString(),
      statusCode,
      error,
      message,
      ...(code ? { code } : {}),
      ...(boxId ? { boxId } : {}),
      ...(progress ? { progress } : {}),
    })
  }
}
