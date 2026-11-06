/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, HttpStatus, NotFoundException, RequestTimeoutException } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { RunnerApiError } from '../box/errors/runner-api-error'
import { BoxCreationAdmissionUnavailableError } from '../box/errors/box-creation-limit.error'
import { BoxPreparingImageTimeoutError } from '../box/errors/box-preparing-image-timeout.error'
import { BoxProgressPhase } from '../box/enums/box-progress-phase.enum'

describe('AllExceptionsFilter', () => {
  it.each(['box-1', undefined, '', 123, { id: 'box-1' }])('only forwards a valid timeout Box ID: %p', async (boxId) => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ path: '/api/v1/org/boxes', url: '/api/v1/org/boxes' }),
      }),
    } as ArgumentsHost

    await filter.catch(new RequestTimeoutException({ message: 'Startup is still pending', boxId }), host)

    expect(status).toHaveBeenCalledWith(HttpStatus.REQUEST_TIMEOUT)
    if (boxId === 'box-1') {
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ boxId: 'box-1' }))
    } else {
      expect(json.mock.calls[0][0]).not.toHaveProperty('boxId')
    }
  })

  it.each([
    ['/.well-known/oauth-protected-resource/api/mcp', false],
    ['/boxes/some-client-route', true],
  ])('answers a missing %s with the dashboard: %p', async (path, dashboard) => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const sendFile = jest.fn()
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, sendFile }),
        getRequest: () => ({ path, url: path }),
      }),
    } as ArgumentsHost

    await filter.catch(new NotFoundException(), host)

    expect(sendFile).toHaveBeenCalledTimes(dashboard ? 1 : 0)
    if (!dashboard) expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND)
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

  /**
   * A timeout on a box still pulling its image says so in the body, in the
   * same shape the box's own representation uses. Everything else about the
   * response stays flat — the structured field is the exception, not the rule.
   */
  it('forwards a failure’s progress and derives its Retry-After', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const setHeader = jest.fn()
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ setHeader, status }),
        getRequest: () => ({ path: '/api/v1/boxes', url: '/api/v1/boxes' }),
      }),
    } as ArgumentsHost
    const exception = new BoxPreparingImageTimeoutError('Timed out waiting for box box-1 to reach started', {
      phase: BoxProgressPhase.PREPARING_IMAGE,
      retryAfterMs: 5000,
    })

    await filter.catch(exception, host)

    expect(status).toHaveBeenCalledWith(HttpStatus.REQUEST_TIMEOUT)
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '5')
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.REQUEST_TIMEOUT,
        message: 'Timed out waiting for box box-1 to reach started',
        progress: { phase: BoxProgressPhase.PREPARING_IMAGE, retryAfterMs: 5000 },
      }),
    )
  })

  it('leaves the body flat when a failure carries no progress', async () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never)
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ path: '/api/v1/boxes', url: '/api/v1/boxes' }),
      }),
    } as ArgumentsHost

    await filter.catch(new RequestTimeoutException('Timed out waiting for box box-1 to reach started'), host)

    expect(json).toHaveBeenCalledWith(expect.not.objectContaining({ progress: expect.anything() }))
  })
})
