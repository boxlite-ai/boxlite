/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { RunnerApiError } from '../box/errors/runner-api-error'

describe('AllExceptionsFilter', () => {
  it('serves the dashboard shell for SPA deep links even when path is prefixed internally', async () => {
    const sendFile = jest.fn()
    const status = jest.fn()
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ sendFile, status }),
        getRequest: () => ({
          originalUrl: '/dashboard/boxes',
          path: '/api/dashboard/boxes',
          url: '/api/dashboard/boxes',
        }),
      }),
    } as ArgumentsHost

    await filter.catch(new NotFoundException('Cannot GET /dashboard/boxes'), host)

    expect(sendFile).toHaveBeenCalledWith(expect.stringContaining('/dashboard/index.html'))
    expect(status).not.toHaveBeenCalled()
  })

  it('serializes HttpException code fields into the JSON response', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ path: '/api/v1/org/boxes', url: '/api/v1/org/boxes' }),
      }),
    } as ArgumentsHost

    await filter.catch(
      new RunnerApiError('Runner API returned a non-JSON error response', 503, 'runner_non_json_error'),
      host,
    )

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/v1/org/boxes',
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'Bad Gateway',
        message: 'Runner API returned a non-JSON error response',
        code: 'runner_non_json_error',
      }),
    )
  })
})
