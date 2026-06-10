jest.mock('../box/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('../region/services/region.service', () => ({
  RegionService: class RegionService {},
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
}))

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MODULE_METADATA } from '@nestjs/common/constants'
import { AuthModule } from './auth.module'
import { JwtStrategy } from './jwt.strategy'

function getJwtStrategyProviderFactory() {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) as Array<any>
  const provider = providers.find((candidate) => candidate?.provide === JwtStrategy)
  if (!provider?.useFactory) {
    throw new Error('JwtStrategy provider factory not found')
  }
  return provider.useFactory as (...args: any[]) => Promise<JwtStrategy>
}

describe('AuthModule JwtStrategy provider', () => {
  it('validates JWT issuer against the public issuer while keeping JWKS on the internal issuer', async () => {
    const createJwtStrategy = getJwtStrategyProviderFactory()
    const oidcMetadataService = {
      getMetadata: jest.fn().mockResolvedValue({
        issuer: 'https://dev-j60pjpmu6neaeaga.us.auth0.com/',
        jwks_uri: 'https://dev-j60pjpmu6neaeaga.us.auth0.com/.well-known/jwks.json',
      }),
    }
    const configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'skipConnections':
            return false
          case 'oidc.audience':
            return 'https://dev.boxlite.ai/api'
          case 'oidc.publicIssuer':
            return 'https://auth.dev.boxlite.ai'
          default:
            return undefined
        }
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'oidc.issuer') {
          return 'https://dev-j60pjpmu6neaeaga.us.auth0.com'
        }
        throw new Error(`missing config ${key}`)
      }),
    }

    const strategy = await createJwtStrategy({} as any, oidcMetadataService as any, configService as any)

    expect((strategy as any).options).toMatchObject({
      audience: 'https://dev.boxlite.ai/api',
      issuer: 'https://auth.dev.boxlite.ai/',
      jwksUri: 'https://dev-j60pjpmu6neaeaga.us.auth0.com/.well-known/jwks.json',
    })
  })
})
