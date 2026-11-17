/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { INestApplication, Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { AddressInfo } from 'node:net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'
import { FeatureUsageController } from './feature-usage.controller'
import { Box } from '../entities/box.entity'

describe('authenticated Cloud feature usage ingestion', () => {
  const boxId = 'AbCdEf123456'
  const id = '11111111-1111-4111-8111-111111111111'
  let actor: Record<string, unknown>
  let app: INestApplication
  let observed: Readonly<Record<string, string>>[]
  let dispose: () => void
  let find: jest.Mock
  let occurredAt: string

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    actor = { role: 'runner', runnerId: 'runner-1' }
    occurredAt = new Date(Date.now() - 1000).toISOString()
    observed = []
    dispose = subscribeBusinessEvents((event) => observed.push(event))
    find = jest.fn().mockResolvedValue([{ id: boxId, organizationId: 'org-1', runnerId: 'runner-1' }])
    const module = await Test.createTestingModule({
      controllers: [FeatureUsageController],
      providers: [{ provide: getRepositoryToken(Box), useValue: { find } }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = actor
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
  })
  afterEach(async () => {
    await app?.close()
    dispose()
    jest.restoreAllMocks()
  })

  function send(events: unknown[], extra = {}): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch('http://127.0.0.1:' + address.port + '/api/telemetry/feature-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, ...extra }),
    })
  }
  const event = (occurredAt: string, overrides = {}) => ({ id, boxId, kind: 'ssh', occurredAt, ...overrides })

  it('preserves source identity/time and derives the organization from the owned Box', async () => {
    const source = event(occurredAt)
    const response = await send([source, source])
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: 1 })
    expect(find).toHaveBeenCalledTimes(1)
    expect(observed).toEqual([
      expect.objectContaining({
        'event.id': id,
        'event.timestamp': occurredAt,
        'organization.id': 'org-1',
        'feature.name': 'ssh',
        'feature.evidence': 'authenticated_session',
        'feature.source': 'runner',
      }),
    ])
  })

  it.each(['tunnel_connection', 'tunnel_request'])('accepts Proxy evidence for %s', async (kind) => {
    actor = { role: 'proxy' }
    const response = await send([event(occurredAt, { kind })])
    expect(await response.json()).toEqual({ accepted: 1 })
    expect(observed[0]).toMatchObject({ 'feature.name': 'tunnel', 'feature.source': 'proxy' })
  })

  it('rejects a Runner reporting another Runner or another producer kind', async () => {
    actor = { role: 'runner', runnerId: 'runner-2' }
    expect(await (await send([event(occurredAt)])).json()).toEqual({ accepted: 0 })
    actor = { role: 'runner', runnerId: 'runner-1' }
    expect(await (await send([event(occurredAt, { kind: 'tunnel_connection' })])).json()).toEqual({ accepted: 0 })
    expect(observed).toEqual([])
  })

  it('rejects Proxy claims of authenticated SSH and unknown resources', async () => {
    actor = { role: 'proxy' }
    expect(await (await send([event(occurredAt)])).json()).toEqual({ accepted: 0 })
    find.mockResolvedValue([])
    expect(await (await send([event(occurredAt, { kind: 'tunnel_connection' })])).json()).toEqual({ accepted: 0 })
    expect(observed).toEqual([])
  })

  it('denies customer principals before reading resource ownership', async () => {
    actor = { role: 'user', userId: 'user-1', organizationId: 'org-1' }
    expect((await send([event(occurredAt)])).status).toBe(403)
    expect(find).not.toHaveBeenCalled()
    expect(observed).toEqual([])
  })

  it.each([
    { id: 'invalid' },
    { boxId: '../private' },
    { kind: 'exec' },
    { occurredAt: 'invalid' },
    { occurredAt: '2026-02-31T00:00:00Z' },
    { command: 'private-command' },
    { organizationId: 'other-org' },
  ])('validates the actual HTTP payload: %s', async (override) => {
    expect((await send([event(occurredAt, override)])).status).toBe(400)
    expect(find).not.toHaveBeenCalled()
    expect(observed).toEqual([])
  })

  it('bounds batch sizes and rejects arbitrary envelope fields', async () => {
    expect((await send([])).status).toBe(400)
    expect((await send(Array.from({ length: 101 }, () => event(occurredAt)))).status).toBe(400)
    expect((await send([event(occurredAt)], { token: 'private-token' })).status).toBe(400)
    expect(find).not.toHaveBeenCalled()
  })

  it('omits stale and implausibly future evidence instead of changing its source time', async () => {
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString()
    expect(await (await send([event(past), event(future)])).json()).toEqual({ accepted: 0 })
    expect(observed).toEqual([])
  })

  it('reports collection unavailability without emitting data or exposing database errors', async () => {
    find.mockRejectedValue(new Error('private-database-password'))
    const response = await send([event(occurredAt)])
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-database-password')
    expect(observed).toEqual([])
  })
})
