/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication, Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import passport from 'passport'
import { AddressInfo } from 'node:net'
import { ApiKeyStrategy } from '../../auth/api-key.strategy'
import { FeatureUsageController } from './feature-usage.controller'
import { Box } from '../entities/box.entity'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'

describe('Cloud feature ingestion credential boundary', () => {
  let app: INestApplication, find: jest.Mock, dispose: () => void
  let observed: Readonly<Record<string, string>>[]
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {})
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    observed = []
    dispose = subscribeBusinessEvents((event) => observed.push(event))
    const strategy = new ApiKeyStrategy(
      { get: async () => null, setex: async () => {} } as any,
      {
        getApiKeyByValue: async (token) => {
          if (token === 'customer-fixture') return { userId: 'customer', organizationId: 'org-1', name: 'customer' }
          throw new Error('unknown key')
        },
        updateLastUsedAt: async () => {},
      } as any,
      { findOne: async () => ({ id: 'customer', role: 'user' }) } as any,
      { get: (key) => (key === 'proxy.apiKey' ? 'proxy-fixture' : undefined) } as any,
      { findByApiKey: async (token) => (token === 'runner-fixture' ? { id: 'runner-1' } : null) } as any,
      { findOneByProxyApiKey: async () => null } as any,
    )
    // These are bearer-key tests; JWT verification has its own suite.
    passport.use('jwt', {
      authenticate() {
        this.fail()
      },
    } as passport.Strategy)
    find = jest.fn().mockResolvedValue([{ id: 'CloudBox1234', organizationId: 'org-1', runnerId: 'runner-1' }])
    const module = await Test.createTestingModule({
      controllers: [FeatureUsageController],
      providers: [
        { provide: ApiKeyStrategy, useValue: strategy },
        { provide: getRepositoryToken(Box), useValue: { find } },
      ],
    }).compile()
    app = module.createNestApplication()
    await app.listen(0, '127.0.0.1')
  })
  afterEach(async () => {
    await app?.close()
    dispose()
    passport.unuse('api-key')
    passport.unuse('jwt')
    jest.restoreAllMocks()
  })
  it.each([
    [undefined, 'ssh', 401],
    ['unknown-fixture', 'ssh', 401],
    ['customer-fixture', 'ssh', 403],
    ['runner-fixture', 'ssh', 202],
    ['proxy-fixture', 'tunnel_request', 202],
  ])('authenticates %s before admitting %s evidence', async (token, kind, status) => {
    const address = app.getHttpServer().address() as AddressInfo
    const response = await fetch('http://127.0.0.1:' + address.port + '/telemetry/feature-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({
        events: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            boxId: 'CloudBox1234',
            kind,
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    })
    expect(response.status).toBe(status)
    expect(observed).toHaveLength(status === 202 ? 1 : 0)
    expect(find).toHaveBeenCalledTimes(status === 202 ? 1 : 0)
  })
})
