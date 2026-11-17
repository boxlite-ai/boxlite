// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { ReplayBusinessFixture } from '../../test/request-replay-business.fixture'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxService } from '../box/services/box.service'
import { BoxRepository } from '../box/repositories/box.repository'
import { DomainService } from '../box/services/domain.service'
import { TunnelService } from '../box/services/tunnel.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { Box } from '../box/entities/box.entity'
import { Tunnel } from '../box/entities/tunnel.entity'
import { Domain } from '../box/entities/domain.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

const describeWithServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

describeWithServices('Request replay state (HTTP, PostgreSQL and Redis)', () => {
  let fixture: ReplayBusinessFixture
  let boxes: BoxService
  let domains: DomainService
  let tunnels: TunnelService
  let runner: Server
  let runnerCalls: number

  beforeEach(async () => {
    fixture = new ReplayBusinessFixture()
    await fixture.open()
    runnerCalls = 0
    runner = createServer((request, response) => {
      runnerCalls++
      request.resume()
      response.writeHead(204).end()
    })
    await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve))
    const events = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) }
    const repository = new BoxRepository(
      fixture.db,
      events as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    // Use the real service methods and repository. Constructor-only unrelated
    // provisioning collaborators are absent; observed metadata has no runner effect.
    boxes = Object.assign(Object.create(BoxService.prototype) as BoxService, {
      boxRepository: repository,
      eventEmitter: events,
      organizationService: { assertOrganizationIsNotSuspended: () => undefined },
      regionService: { findOne: async () => ({ id: 'us' }) },
      boxActivityService: { getLastActivityAt: async () => null },
      imagePreparationService: { preparingImage: async () => new Set<string>() },
      runnerService: {
        findOne: async () => ({
          apiUrl: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`,
          apiKey: 'test-key',
        }),
      },
    })
    domains = new DomainService(
      fixture.db,
      { findOne: async () => null } as never,
      {
        get: (key: string) => (['domain.appDomain', 'domain.appHost'].includes(key) ? 'apps.example.test' : undefined),
        getOrThrow: (key: string) =>
          key === 'domain.platformSubdomainMinLength' ? 5 : key === 'proxy.protocol' ? 'https' : 'proxy.example.test',
      } as never,
      {} as never,
    )
    tunnels = new TunnelService(fixture.db.getRepository(Tunnel), fixture.redis)
    await fixture.serve(
      [BoxliteBoxController, BoxliteDomainController, BoxliteProxyController],
      [
        { provide: BoxService, useValue: boxes },
        { provide: DomainService, useValue: domains },
        { provide: TunnelService, useValue: tunnels },
        { provide: RunnerService, useValue: {} },
        { provide: BoxAutoResumeService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: {} },
        { provide: CheckpointRecoverService, useValue: {} },
        {
          provide: BoxStateWaiterService,
          useValue: {
            waitForStarted: async (id: string) => {
              await fixture.db.getRepository(Box).update(id, { state: BoxState.STARTED, pending: false })
              return boxes.toBoxDto(await fixture.db.getRepository(Box).findOneByOrFail({ id }))
            },
          },
        },
      ],
    )
  })
  afterEach(async () => {
    await fixture?.close()
    if (runner) {
      runner.closeAllConnections()
      await new Promise<void>((resolve) => runner.close(() => resolve()))
    }
  })

  async function box(name: string, state = BoxState.STARTED) {
    const created = Object.assign(new Box('us', name), {
      organizationId: fixture.organization.id,
      osUser: 'boxlite',
      image: 'registry.example/app:tag',
      state,
      desiredState: state === BoxState.STARTED ? BoxDesiredState.STARTED : BoxDesiredState.STOPPED,
      runnerId: randomUUID(),
      cpu: 1,
      mem: 1,
      disk: 1,
    })
    return fixture.db.getRepository(Box).save(created)
  }

  it('does not stop or start again after the current lifecycle changes', async () => {
    const target = await box('lifecycle')
    const stopKey = randomUUID()
    const stopped = await fixture.request('POST', `boxes/${target.id}/stop`, stopKey)
    await fixture.db
      .getRepository(Box)
      .update(target.id, { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED, pending: false })
    const afterStop = [...fixture.events]
    await fixture.replay('POST', `boxes/${target.id}/stop`, stopKey, stopped)
    expect((await fixture.db.getRepository(Box).findOneByOrFail({ id: target.id })).desiredState).toBe(
      BoxDesiredState.STARTED,
    )
    expect(fixture.events).toEqual(afterStop)
    await fixture.db
      .getRepository(Box)
      .update(target.id, { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false })
    const startKey = randomUUID()
    const started = await fixture.request('POST', `boxes/${target.id}/start`, startKey)
    await fixture.db
      .getRepository(Box)
      .update(target.id, { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false })
    const afterStart = [...fixture.events]
    await fixture.replay('POST', `boxes/${target.id}/start`, startKey, started)
    expect((await fixture.db.getRepository(Box).findOneByOrFail({ id: target.id })).desiredState).toBe(
      BoxDesiredState.STOPPED,
    )
    expect(fixture.events).toEqual(afterStart)
  })

  it('does not delete a new Box occupying the original name', async () => {
    const original = await box('replaceable')
    const key = randomUUID()
    const removed = await fixture.request('DELETE', 'boxes/replaceable', key)
    await fixture.db.getRepository(Box).delete(original.id)
    const replacement = await box('replaceable')
    const events = [...fixture.events]
    await fixture.replay('DELETE', 'boxes/replaceable', key, removed)
    expect(await fixture.db.getRepository(Box).findOneByOrFail({ id: replacement.id })).toEqual(replacement)
    expect(fixture.events).toEqual(events)
  })

  it('replays claim, bind and unbind without overwriting a newer domain target', async () => {
    const first = await box('domain-first')
    const second = await box('domain-second')
    const claimKey = randomUUID()
    const claimed = await fixture.request('POST', 'domains', claimKey, { name: 'replay-domain' })
    const hostname = 'replay-domain.apps.example.test'
    await domains.bind(first, 3000, hostname)
    await fixture.replay('POST', 'domains', claimKey, claimed, { name: 'replay-domain' })
    expect((await fixture.db.getRepository(Domain).findOneByOrFail({ hostname })).boxId).toBe(first.id)
    const bindKey = randomUUID()
    const body = { type: 'box', box: first.id, port: 3000 }
    const bound = await fixture.request('PUT', `domains/${hostname}/target`, bindKey, body)
    await domains.bind(second, 4000, hostname)
    await fixture.replay('PUT', `domains/${hostname}/target`, bindKey, bound, body)
    expect((await fixture.db.getRepository(Domain).findOneByOrFail({ hostname })).boxId).toBe(second.id)
    const unbindKey = randomUUID()
    const unbound = await fixture.request('DELETE', `domains/${hostname}/target`, unbindKey)
    await domains.bind(second, 5000, hostname)
    await fixture.replay('DELETE', `domains/${hostname}/target`, unbindKey, unbound)
    expect((await fixture.db.getRepository(Domain).findOneByOrFail({ hostname })).port).toBe(5000)
  })

  it('preserves newer inbound/outbound settings and a recreated tunnel', async () => {
    const target = await box('network')
    const inboundKey = randomUUID()
    const inbound = await fixture.request('PUT', `boxes/${target.id}/network/inbound`, inboundKey, { mode: 'enabled' })
    await boxes.updateInboundEnabled(target.id, false, fixture.organization.id)
    await fixture.replay('PUT', `boxes/${target.id}/network/inbound`, inboundKey, inbound, { mode: 'enabled' })
    expect((await fixture.db.getRepository(Box).findOneByOrFail({ id: target.id })).inboundEnabled).toBe(false)
    const outboundKey = randomUUID()
    const policy = { mode: 'disabled', allow_net: [] }
    const outbound = await fixture.request('PUT', `boxes/${target.id}/network/outbound`, outboundKey, policy)
    await fixture.db.getRepository(Box).update(target.id, { outboundEnabled: true })
    await fixture.replay('PUT', `boxes/${target.id}/network/outbound`, outboundKey, outbound, policy)
    expect((await fixture.db.getRepository(Box).findOneByOrFail({ id: target.id })).outboundEnabled).toBe(true)
    expect(runnerCalls).toBe(1)
    await tunnels.prepare(target.id, 3000)
    const revokeKey = randomUUID()
    const revoked = await fixture.request('DELETE', `boxes/${target.id}/network/tunnel?port=3000`, revokeKey)
    await tunnels.prepare(target.id, 3000)
    const replacement = await fixture.db.getRepository(Tunnel).findOneByOrFail({ boxId: target.id, port: 3000 })
    await fixture.replay('DELETE', `boxes/${target.id}/network/tunnel?port=3000`, revokeKey, revoked)
    expect(await fixture.db.getRepository(Tunnel).findOneByOrFail({ id: replacement.id })).toEqual(replacement)
    expect(replacement.revokedAt).toBeNull()
  })
})
