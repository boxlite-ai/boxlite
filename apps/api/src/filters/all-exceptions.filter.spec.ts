/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, HttpStatus } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { RunnerApiError } from '../box/errors/runner-api-error'
import { BoxCreationAdmissionUnavailableError } from '../box/errors/box-creation-limit.error'

describe('AllExceptionsFilter', () => {
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

  it('sets Retry-After for a temporarily contended creation admission', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const setHeader = jest.fn()
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ setHeader, status }),
        getRequest: () => ({ path: '/api/v1/org/boxes', url: '/api/v1/org/boxes' }),
      }),
    } as ArgumentsHost
    const exception = new BoxCreationAdmissionUnavailableError('Box creation admission remained contended', 5)

    await filter.catch(exception, host)

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '5')
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE)
  })
})
