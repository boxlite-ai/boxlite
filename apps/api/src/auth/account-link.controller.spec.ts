/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

function controller(enabled: boolean) {
  const service = {
    adopt: jest.fn().mockResolvedValue({}),
    status: jest.fn().mockResolvedValue({ known: true }),
  }
  const config = { get: jest.fn(() => enabled) } as unknown as TypedConfigService
  return { service, controller: new AccountLinkController(config, service as unknown as AccountLinkService) }
}

describe.each(['adopt', 'status'] as const)('AccountLinkController.%s', (route) => {
  it('answers 404 while the account link is off', async () => {
    const { service, controller: off } = controller(false)

    await expect(off[route]('Bearer token')).rejects.toBeInstanceOf(NotFoundException)
    expect(service[route]).not.toHaveBeenCalled()
  })

  it('refuses a request without a bearer token', async () => {
    const { service, controller: on } = controller(true)

    await expect(on[route](undefined)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(on[route]('Basic abc')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(service[route]).not.toHaveBeenCalled()
  })

  it('hands the bearer token to the service', async () => {
    const { service, controller: on } = controller(true)

    await on[route]('Bearer header.payload.signature')

    expect(service[route]).toHaveBeenCalledWith('header.payload.signature')
  })
})
