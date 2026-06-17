/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

function normalizeStatusCode(statusCode?: number): number {
  if (!statusCode) {
    return HttpStatus.BAD_GATEWAY
  }

  if (statusCode >= 400 && statusCode < 500) {
    return statusCode
  }

  return HttpStatus.BAD_GATEWAY
}

export class RunnerApiError extends HttpException {
  public readonly runnerStatusCode?: number
  public readonly statusCode?: number
  public readonly code: string

  constructor(message: string, statusCode?: number, code = 'RUNNER_API_ERROR') {
    const apiStatusCode = normalizeStatusCode(statusCode)
    super(
      {
        statusCode: apiStatusCode,
        message,
        code,
      },
      apiStatusCode,
    )
    this.name = 'RunnerApiError'
    this.runnerStatusCode = statusCode
    this.statusCode = statusCode
    this.code = code
  }
}
