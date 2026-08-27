/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException } from '@nestjs/common'
import { MaintenanceMiddleware } from './maintenance.middleware'

const makeMiddleware = (maintananceMode: boolean) => {
  const configService = { get: jest.fn().mockReturnValue(maintananceMode) }
  return new MaintenanceMiddleware(configService as never)
}

describe('MaintenanceMiddleware', () => {
  it('passes requests through while maintenance is off', () => {
    const next = jest.fn()

    makeMiddleware(false).use({} as never, {} as never, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  // The 503 is often the only thing a caller sees during maintenance, so it
  // must carry the one place that says what is going on.
  it('rejects with a 503 that points at the status page while maintenance is on', () => {
    const next = jest.fn()

    let thrown: HttpException | undefined
    try {
      makeMiddleware(true).use({} as never, {} as never, next)
    } catch (error) {
      thrown = error as HttpException
    }

    expect(next).not.toHaveBeenCalled()
    expect(thrown).toBeInstanceOf(HttpException)
    expect(thrown?.getStatus()).toBe(503)
    expect(thrown?.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 503,
        error: 'Service Unavailable',
        message: expect.stringContaining('https://status.boxlite.ai'),
      }),
    )
  })
})
