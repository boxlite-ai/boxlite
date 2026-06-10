/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { JwtStrategy } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'

const DEFAULT_REGION_ID = 'region-default-id'
const DEFAULT_ORG_QUOTA = { totalCpuQuota: 8 }

function buildStrategy() {
  const createdUser = { id: 'user-1', role: 'user', email: 'new@boxlite.dev' }

  const userService = {
    findOne: jest.fn().mockResolvedValue(null), // new user → triggers create()
    create: jest.fn().mockResolvedValue(createdUser),
    update: jest.fn(),
  } as unknown as UserService

  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'defaultRegion.id') return DEFAULT_REGION_ID
      if (key === 'defaultOrganizationQuota') return DEFAULT_ORG_QUOTA
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
})
