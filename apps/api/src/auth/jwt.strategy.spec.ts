/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { Request } from 'express'
import { JwtStrategy } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'

const DEFAULT_REGION_ID = 'region-default-id'

function buildStrategy(options: { skipUserEmailVerification?: boolean } = {}) {
  const createdUser = { id: 'user-1', role: 'user', email: 'new@boxlite.dev' }

  const userService = {
    findOne: jest.fn().mockResolvedValue(null), // new user → triggers create()
    create: jest.fn().mockResolvedValue(createdUser),
    update: jest.fn(),
  } as unknown as UserService

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'skipUserEmailVerification') return options.skipUserEmailVerification ?? false
      return undefined
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'defaultRegion.id') return DEFAULT_REGION_ID
      throw new Error(`unexpected config key: ${key}`)
    }),
  } as unknown as TypedConfigService

  const strategy = new JwtStrategy(
    { jwksUri: 'https://example.com/.well-known/jwks.json', audience: 'aud', issuer: 'iss' },
    userService,
    configService,
  )

  return { strategy, userService }
}

describe('JwtStrategy.validate — auto-created user', () => {
  it('anchors the Personal org to the default region for a new OIDC user', async () => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await strategy.validate(request, { sub: 'user-1', email: 'new@boxlite.dev', email_verified: true })

    // The bug: without defaultOrganizationDefaultRegionId, the downstream
    // UserCreatedEvent → handleUserCreatedEvent creates the default org with
    // defaultRegionId=undefined. Assert the strategy forwards the configured
    // region id into the create DTO.
    expect(userService.create).toHaveBeenCalledTimes(1)
    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({ defaultOrganizationDefaultRegionId: DEFAULT_REGION_ID }),
    )
  })

  it.each([
    ['false', false],
    ['missing', undefined],
  ])('rejects an OIDC token whose email_verified claim is %s before provisioning a user', async (_label, claim) => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await expect(
      strategy.validate(request, { sub: 'user-1', email: 'new@boxlite.dev', email_verified: claim }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(userService.findOne).not.toHaveBeenCalled()
    expect(userService.create).not.toHaveBeenCalled()
    expect(userService.update).not.toHaveBeenCalled()
  })

  it('keeps local OIDC providers usable when email verification is explicitly skipped', async () => {
    const { strategy, userService } = buildStrategy({ skipUserEmailVerification: true })
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await strategy.validate(request, { sub: 'user-1', email: 'new@boxlite.dev' })

    expect(userService.create).toHaveBeenCalledTimes(1)
  })
})
