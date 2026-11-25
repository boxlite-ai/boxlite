/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { ThrottlerStorageService } from '@nestjs/throttler'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxCostService } from '../usage/services/box-cost.service'
import { BoxliteBoxController } from './boxlite-box.controller'

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

describe('Box cost rate limit', () => {
  let app: INestApplication
  let storage: ThrottlerStorageService
  let getCost: jest.Mock

  beforeEach(async () => {
    getCost = jest.fn().mockResolvedValue({})
    storage = new ThrottlerStorageService()
    const limiter = new AuthenticatedRateLimitGuard(
      [
        { name: 'authenticated', ttl: 60_000, limit: 1 },
        { name: 'box-create', ttl: 60_000, limit: 1 },
        { name: 'box-cost', ttl: 60_000, limit: 2 },
      ],
      storage,
      new Reflector(),
      { get: async () => null, set: async () => 'OK' } as never,
      { findOne: async () => ({ authenticatedRateLimit: 1 }) } as never,
    )
    await limiter.onModuleInit()
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [{ provide: BoxCostService, useValue: { getCost } }],
    })
      .useMocker(() => ({}))
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          const id = request.headers['x-test-org'] ?? 'org-1'
          request.user = { userId: 'user-1', role: SystemRole.USER, organizationId: id, organization: { id } }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue(limiter)
      .compile()
    app = moduleRef.createNestApplication()
    await app.listen(0, '127.0.0.1')
  })

  afterEach(async () => {
    await app?.close()
    storage?.onApplicationShutdown()
  })

  it('limits cost reads per organization, on their own quota and with a standard Retry-After', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo
    const read = (headers = {}) => fetch(`http://127.0.0.1:${port}/v1/boxes/aB3cD4eF5gH6/cost`, { headers })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await read()
      expect(response.status).toBe(200)
      expect(response.headers.has('x-ratelimit-limit-authenticated')).toBe(false)
    }
    const limited = await read()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(getCost).toHaveBeenCalledTimes(2)
    expect((await read({ 'x-test-org': 'org-2' })).status).toBe(200)
  })
})
