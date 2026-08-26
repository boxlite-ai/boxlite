/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, HttpStatus } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { RunnerApiError } from '../box/errors/runner-api-error'
import { BoxError } from '../exceptions/box-error.exception'

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

  // Without a code the SDKs cannot tell a lifecycle guard from a server
  // crash: the flat envelope is all they get, and a code-less body used to
  // be read as `internal`. A transient state conflict is precisely the case
  // a client should be able to retry on.
  it('carries a machine code for box lifecycle guards', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ path: '/api/v1/org/boxes/abc/start', url: '/api/v1/org/boxes/abc/start' }),
      }),
    } as ArgumentsHost

    await filter.catch(new BoxError('State change in progress'), host)

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'State change in progress',
        code: 'invalid_state',
      }),
    )
  })

  it('lets a non-lifecycle BoxError override the code', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ path: '/api/v1/org/boxes', url: '/api/v1/org/boxes' }),
      }),
    } as ArgumentsHost

    await filter.catch(new BoxError('Runner not found for warm pool box', 'internal'), host)

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'internal' }))
  })
})
