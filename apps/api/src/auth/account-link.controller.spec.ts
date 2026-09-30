/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

function controller(enabled: boolean) {
  const adopt = jest.fn().mockResolvedValue({})
  const config = { get: jest.fn(() => enabled) } as unknown as TypedConfigService
  return { adopt, controller: new AccountLinkController(config, { adopt } as unknown as AccountLinkService) }
}

describe('AccountLinkController.adopt', () => {
  it('answers 404 while the account link is off', async () => {
    const { adopt, controller: off } = controller(false)

    await expect(off.adopt('Bearer token')).rejects.toBeInstanceOf(NotFoundException)
    expect(adopt).not.toHaveBeenCalled()
  })

  it('refuses a request without a bearer token', async () => {
    const { adopt, controller: on } = controller(true)

    await expect(on.adopt(undefined)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(on.adopt('Basic abc')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(adopt).not.toHaveBeenCalled()
  })

  it('hands the bearer token to the service', async () => {
    const { adopt, controller: on } = controller(true)

    await on.adopt('Bearer header.payload.signature')

    expect(adopt).toHaveBeenCalledWith('header.payload.signature')
  })
})
