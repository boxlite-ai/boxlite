/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { ConfigService } from '@nestjs/config'
import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { EntityNotFoundError, IsNull } from 'typeorm'
import { ReplayBusinessFixture } from '../../test/request-replay-business.fixture'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JwtStrategy } from '../auth/jwt.strategy'
import { UserService } from '../user/user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { TypedConfigService } from '../config/typed-config.service'
import { RunnerService } from '../box/services/runner.service'
import { RegionService } from '../region/services/region.service'
import { VolumeService } from '../box/services/volume.service'
import { VolumeAccessGuard } from '../box/guards/volume-access.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { apiKeyValidationCacheKey, generateApiKeyHash } from '../common/utils/api-key'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteCheckpointController } from './boxlite-checkpoint.controller'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { BoxliteImageController } from './boxlite-image.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteRegistryController } from './boxlite-registry.controller'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { BoxService } from '../box/services/box.service'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { CheckpointService } from '../box/services/checkpoint.service'
import { CheckpointJobReceiver } from '../box/services/checkpoint-job-receiver.service'
import { JobService } from '../box/services/job.service'
import { BoxRepository } from '../box/repositories/box.repository'
import { DomainService } from '../box/services/domain.service'
import { TunnelService } from '../box/services/tunnel.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { RegistriesService } from '../registry/services/registries.service'
import { RegistryCredential } from '../registry/entities/registry-credential.entity'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { ImageRegistrarService } from '../image/services/image-registrar.service'
import { Image } from '../image/entities/image.entity'
import { ImageVersion } from '../image/entities/image-version.entity'
import { ImageAlias } from '../image/entities/image-alias.entity'
import { ImageAliasEvent } from '../image/entities/image-alias-event.entity'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { Box } from '../box/entities/box.entity'
import { Tunnel } from '../box/entities/tunnel.entity'
import { Domain } from '../box/entities/domain.entity'
import { Runner } from '../box/entities/runner.entity'
import { Job } from '../box/entities/job.entity'
import { Volume } from '../box/entities/volume.entity'
import { Checkpoint, CheckpointArchive } from '../box/entities/checkpoint.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { RunnerState } from '../box/enums/runner-state.enum'
import { VolumeState } from '../box/enums/volume-state.enum'
import { JobStatus } from '../box/enums/job-status.enum'
import { JobType } from '../box/enums/job-type.enum'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

const describeWithRedis = process.env.REDIS_HOST ? describe : describe.skip
const describeWithServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

/** Real Passport authentication, organization/resource guards, and Redis replay; persistence boundaries stay local. */
describeWithRedis('Request replay current authorization and deleted volume evidence', () => {
  const org = randomUUID()
  const otherOrg = randomUUID()
  const userId = `replay-auth-${randomUUID()}`
  const highToken = `high-${randomUUID()}`
  const lowToken = `low-${randomUUID()}`
  const otherToken = `other-${randomUUID()}`
  const keys = new Map<string, ApiKey>()
  const volumes = new Map<string, string>()
  let member = true
  let redis: Redis
  let app: INestApplication
  let base: string
  let replay: BoxRequestReplayService
  const remove = jest.fn(async (id: string) => {
    volumes.delete(id)
  })
  const getOrganizationId = jest.fn(async ({ id }: { id: string }) => {
    const organizationId = volumes.get(id)
    if (!organizationId) throw new EntityNotFoundError('Volume', { id })
    return organizationId
  })

  const credential = (organizationId: string, permissions: OrganizationResourcePermission[], name: string) =>
    Object.assign(new ApiKey(), {
      organizationId,
      userId,
      permissions,
      name,
      createdAt: new Date(),
      keySuffix: 'fixture',
    })

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    })
    await redis.ping()
    const userService = { findOne: async () => ({ id: userId, email: 'replay@example.test', role: SystemRole.USER }) }
    const configService = { get: (key: string) => (key.endsWith('Seconds') ? 10 : undefined) }
    const module = await Test.createTestingModule({
      controllers: [BoxliteVolumeController],
      providers: [
        BoxRequestReplayService,
        RequestReplayInterceptor,
        ApiKeyStrategy,
        OrganizationResourceActionGuard,
        VolumeAccessGuard,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: UserService, useValue: userService },
        { provide: TypedConfigService, useValue: configService },
        {
          provide: ApiKeyService,
          useValue: {
            getApiKeyByValue: async (token: string) => {
              const key = keys.get(token)
              if (!key) throw new UnauthorizedException('Revoked key')
              return key
            },
            updateLastUsedAt: async () => undefined,
          },
        },
        { provide: RunnerService, useValue: { findByApiKey: async () => null } },
        { provide: RegionService, useValue: { findOneByProxyApiKey: async () => null } },
        {
          provide: OrganizationService,
          useValue: { findOne: async (id: string) => (id === org || id === otherOrg ? { id } : null) },
        },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: async (organizationId: string) =>
              member ? { organizationId, userId, role: 'member', assignedRoles: [] } : null,
          },
        },
        { provide: VolumeService, useValue: { getOrganizationId, delete: remove } },
        // The production JWT strategy rejects opaque, non-JWT API keys locally; no issuer request is needed.
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              {
                jwksUri: 'http://127.0.0.1/unused-jwks',
                audience: 'replay-test',
                issuer: 'replay-test',
              },
              userService as never,
              configService as never,
              {} as never,
            ),
        },
      ],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    replay = app.get(BoxRequestReplayService)
    app.useGlobalInterceptors(app.get(RequestReplayInterceptor))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })

  async function clearAuthCaches() {
    await redis.del(
      ...[highToken, lowToken, otherToken].map((token) => apiKeyValidationCacheKey(generateApiKeyHash(token))),
      `api-key:user:${userId}`,
      OrganizationUserService.membershipCacheKey(org, userId),
      OrganizationUserService.membershipCacheKey(otherOrg, userId),
    )
  }

  beforeEach(async () => {
    member = true
    keys.set(highToken, credential(org, [OrganizationResourcePermission.DELETE_VOLUMES], 'high'))
    keys.set(lowToken, credential(org, [], 'low'))
    keys.set(otherToken, credential(otherOrg, [OrganizationResourcePermission.DELETE_VOLUMES], 'other'))
    await clearAuthCaches()
    jest.clearAllMocks()
  })

  afterAll(async () => {
    await app?.close()
    if (redis) {
      await clearAuthCaches()
      const records = await redis.keys(`replay:${org}:*`)
      const otherRecords = await redis.keys(`replay:${otherOrg}:*`)
      if (records.length + otherRecords.length) await redis.del(...records, ...otherRecords)
      await redis.del(`organization:${org}`, `organization:${otherOrg}`)
      await redis.quit()
    }
  })

  const send = (volumeId: string, key: string, token = highToken, prefix = '', query = '') =>
    fetch(`${base}/api/v1/${prefix ? `${prefix}/` : ''}volumes/${volumeId}${query}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
    })

  async function completedDelete() {
    const volumeId = randomUUID()
    const key = randomUUID()
    volumes.set(volumeId, org)
    const first = await send(volumeId, key)
    expect(first.status).toBe(204)
    const hash = createHash('sha256').update(key).digest('hex')
    const deadline = Date.now() + 2_000
    let record: string | undefined
    while (Date.now() < deadline) {
      record = (await redis.keys(`replay:${org}:*:${hash}`))[0]
      if (record && (await redis.hget(record, 'state')) === 'complete') return { volumeId, key, record }
      await delay(5)
    }
    throw new Error('Authorized delete response was not completed')
  }

  it('replays an authorized delete after physical removal without dispatching another delete', async () => {
    const { volumeId, key } = await completedDelete()
    expect(volumes.has(volumeId)).toBe(false)
    const retry = await send(volumeId, key)
    expect(retry.status).toBe(204)
    expect(await retry.text()).toBe('')
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects a revoked API credential before returning its completed response', async () => {
    const { volumeId, key } = await completedDelete()
    keys.delete(highToken)
    await clearAuthCaches()
    expect((await send(volumeId, key)).status).toBe(401)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects membership removal before returning the completed response', async () => {
    const { volumeId, key } = await completedDelete()
    member = false
    await clearAuthCaches()
    expect((await send(volumeId, key)).status).toBe(403)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects a lower-permission key belonging to the same user', async () => {
    const { volumeId, key } = await completedDelete()
    expect((await send(volumeId, key, lowToken)).status).toBe(403)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects revoked permissions on the original key', async () => {
    const { volumeId, key } = await completedDelete()
    keys.get(highToken)!.permissions = []
    await clearAuthCaches()
    expect((await send(volumeId, key)).status).toBe(403)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('never exposes deleted resource evidence across organizations or prefixes', async () => {
    const { volumeId, key } = await completedDelete()
    expect((await send(volumeId, key, otherToken)).status).toBe(404)
    expect((await send(volumeId, key, highToken, otherOrg)).status).toBe(403)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('does not use completed evidence for a changed resource or business query', async () => {
    const { volumeId, key } = await completedDelete()
    expect((await send(randomUUID(), key)).status).toBe(404)
    expect((await send(volumeId, key, highToken, '', '?force=false')).status).toBe(404)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('never dispatches when completed evidence disappears between guard lookup and reservation', async () => {
    const { volumeId, key, record } = await completedDelete()
    const peek = replay.peekCompleted.bind(replay)
    const spy = jest.spyOn(replay, 'peekCompleted').mockImplementationOnce(async (...args) => {
      const response = await peek(...args)
      await redis.del(record)
      return response
    })
    try {
      const retry = await send(volumeId, key)
      expect(retry.status).toBe(422)
      expect(await retry.json()).toMatchObject({ code: 'idempotency_outcome_unknown' })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(await redis.exists(record)).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('never accepts records without trusted original ownership', async () => {
    const { volumeId, key, record } = await completedDelete()
    const serialized = await redis.hget(record, 'response')
    const stored = JSON.parse(serialized!) as { resource?: { id: string; organizationId: string } }
    delete stored.resource
    await redis.hset(record, 'response', JSON.stringify(stored))
    expect((await send(volumeId, key)).status).toBe(404)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describeWithServices('Request replay business resources (HTTP, PostgreSQL and Redis)', () => {
  describe('checkpoints and volumes', () => {
    let fixture: ReplayBusinessFixture
    let checkpoints: CheckpointService
    let receiver: CheckpointJobReceiver
    const archiveStore = { remove: jest.fn() }
    const notifications = { lpush: jest.fn().mockResolvedValue(1) }

    beforeEach(async () => {
      fixture = new ReplayBusinessFixture()
      await fixture.open()
      const cache = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
      const events = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) }
      const repository = new BoxRepository(fixture.db, events as never, cache as never)
      const jobs = new JobService(fixture.db.getRepository(Job), notifications as never, {} as never)
      archiveStore.remove.mockReset().mockResolvedValue(undefined)
      notifications.lpush.mockClear()
      checkpoints = new CheckpointService(
        fixture.db,
        {
          get: () => ({ archivePrefix: 'gs://replay-tests/checkpoints/', maxPerOrganization: 10, enabled: true }),
        } as unknown as ConfigService,
        jobs,
        cache as never,
        archiveStore as never,
      )
      receiver = new CheckpointJobReceiver(fixture.db, cache as never, events as never, notifications as never)
      const volumes = new VolumeService(
        fixture.db.getRepository(Volume),
        repository,
        { assertOrganizationIsNotSuspended: () => undefined } as never,
        { get: (key: string) => (key === 'volume.storageBackend' ? 'gcs' : undefined) } as never,
        {} as never,
      )
      // The storage worker is outside this request. Persist READY at its database boundary,
      // leaving the production create and waitForReady implementations intact.
      fixture.db.subscribers.push({
        listenTo: () => Volume,
        afterInsert: async (event) => {
          await event.manager.update(Volume, event.entity.id, { state: VolumeState.READY })
        },
      })
      await fixture.serve(
        [BoxliteCheckpointController, BoxliteVolumeController],
        [
          { provide: CheckpointService, useValue: checkpoints },
          { provide: VolumeService, useValue: volumes },
        ],
      )
    })
    afterEach(async () => fixture?.close())

    async function finish(jobId: string, archive: CheckpointArchive) {
      const jobs = fixture.db.getRepository(Job)
      await jobs.update(jobId, {
        status: JobStatus.COMPLETED,
        completedAt: new Date(),
        resultMetadata: JSON.stringify(archive),
      })
      await receiver.handleJobCompletion(await jobs.findOneByOrFail({ id: jobId }))
    }

    it('returns the unnamed checkpoint creating response after export and upload finish, then replays deletion', async () => {
      const runner = new Runner({
        region: 'us',
        name: 'replay',
        apiKey: 'test-key',
        apiVersion: '2',
        cpu: 64,
        memoryGiB: 128,
        diskGiB: 1000,
      })
      runner.state = RunnerState.READY
      await fixture.db.getRepository(Runner).save(runner)
      const box = Object.assign(new Box('us', 'checkpoint-source'), {
        organizationId: fixture.organization.id,
        runnerId: runner.id,
        osUser: 'boxlite',
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STOPPED,
        image: 'registry.example/app:tag',
        cpu: 4,
        mem: 8,
        disk: 12,
        env: {},
        entrypoint: ['/app'],
        cmd: [],
        workingDir: '/work',
      })
      await fixture.db.getRepository(Box).save(box)
      const key = randomUUID()
      const body = { source_box_id: box.id }
      const original = await fixture.request('POST', 'checkpoints', key, body)
      expect(original.body).toMatchObject({ state: 'creating', source_box_id: box.id })
      const checkpoint = await fixture.db.getRepository(Checkpoint).findOneByOrFail({ sourceBoxId: box.id })
      expect(original.body?.id).toBe(checkpoint.id)
      const archive: CheckpointArchive = {
        checkpointId: checkpoint.id,
        exportJobId: checkpoint.exportJobId!,
        sourceBoxId: box.id,
        arcPath: checkpoint.arcPath,
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        pinnedImage: `registry.example/app@sha256:${'b'.repeat(64)}`,
      }
      await finish(checkpoint.exportJobId!, archive)
      const uploading = await checkpoints.get(fixture.organization.id, checkpoint.id)
      await finish(uploading.activeJobId!, archive)
      expect((await checkpoints.get(fixture.organization.id, checkpoint.id)).state).toBe('ready')
      await fixture.replay('POST', 'checkpoints', key, original, body)
      expect(await fixture.db.getRepository(Checkpoint).count()).toBe(1)
      expect(await fixture.db.getRepository(Job).countBy({ type: JobType.EXPORT_CHECKPOINT })).toBe(1)
      expect(await fixture.db.getRepository(Job).countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
      const deleteKey = randomUUID()
      const removed = await fixture.request('DELETE', `checkpoints/${checkpoint.id}`, deleteKey)
      expect(await fixture.db.getRepository(Checkpoint).count()).toBe(0)
      await fixture.replay('DELETE', `checkpoints/${checkpoint.id}`, deleteKey, removed)
      expect(archiveStore.remove).toHaveBeenCalledTimes(1)
    })

    it('creates one unnamed volume and preserves ready bytes after its state changes and deletion completes', async () => {
      const key = randomUUID()
      const original = await fixture.request('POST', 'volumes', key, {})
      const volume = await fixture.db.getRepository(Volume).findOneByOrFail({ organizationId: fixture.organization.id })
      expect(original.body).toMatchObject({ id: volume.id, name: volume.id, state: VolumeState.READY })
      await fixture.db.getRepository(Volume).update(volume.id, { state: VolumeState.ERROR })
      const events = [...fixture.events]
      await fixture.replay('POST', 'volumes', key, original, {})
      expect(await fixture.db.getRepository(Volume).count()).toBe(1)
      expect(fixture.events).toEqual(events)
      const deleteKey = randomUUID()
      const removed = await fixture.request('DELETE', `volumes/${volume.id}`, deleteKey)
      expect((await fixture.db.getRepository(Volume).findOneByOrFail({ id: volume.id })).state).toBe(
        VolumeState.PENDING_DELETE,
      )
      await fixture.db.getRepository(Volume).delete(volume.id)
      const deletionEvents = [...fixture.events]
      await fixture.replay('DELETE', `volumes/${volume.id}`, deleteKey, removed)
      expect(fixture.events).toEqual(deletionEvents)
      expect(await fixture.db.getRepository(Volume).count()).toBe(0)
      expect(
        events.filter((event) => event['event.name'] === 'volume.create' && event['event.outcome'] === 'success'),
      ).toHaveLength(1)
    })
  })

  describe('box lifecycle, domains and network', () => {
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
      // A server listening on an explicit host reports an AddressInfo.
      const runnerAddress = runner.address() as AddressInfo
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
            apiUrl: `http://127.0.0.1:${runnerAddress.port}`,
            apiKey: 'test-key',
          }),
        },
      })
      domains = new DomainService(
        fixture.db,
        { findOne: async () => null } as never,
        {
          get: (key: string) =>
            ['domain.appDomain', 'domain.appHost'].includes(key) ? 'apps.example.test' : undefined,
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
      const inbound = await fixture.request('PUT', `boxes/${target.id}/network/inbound`, inboundKey, {
        mode: 'enabled',
      })
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

  describe('registries and image aliases', () => {
    let fixture: ReplayBusinessFixture
    let registries: RegistriesService
    let catalog: ImageCatalogService
    let registrar: ImageRegistrarService
    const secret = { put: jest.fn(), destroy: jest.fn() }
    const digest = `sha256:${'a'.repeat(64)}`
    const name = 'quay.io/replay/app'
    const route = `images/${encodeURIComponent(name)}`
    const previousRegistryProxyHost = process.env.REGISTRY_PROXY_HOST

    beforeEach(async () => {
      process.env.REGISTRY_PROXY_HOST = 'registry-proxy.replay.test'
      fixture = new ReplayBusinessFixture()
      await fixture.open()
      secret.put.mockReset().mockImplementation(async () => randomUUID())
      secret.destroy.mockReset().mockResolvedValue(undefined)
      registries = new RegistriesService(fixture.db.getRepository(RegistryCredential), secret)
      catalog = new ImageCatalogService(
        fixture.db.getRepository(Image),
        fixture.db.getRepository(ImageVersion),
        fixture.db.getRepository(ImageAlias),
        fixture.db.getRepository(ImageAliasEvent),
        fixture.db.getRepository(Box),
      )
      registrar = new ImageRegistrarService(fixture.db, { remember: async () => undefined } as never)
      await fixture.serve(
        [BoxliteRegistryController, BoxliteImageController],
        [
          { provide: RegistriesService, useValue: registries },
          { provide: ImageCatalogService, useValue: catalog },
        ],
      )
    })
    afterEach(async () => {
      try {
        await fixture?.close()
      } finally {
        if (previousRegistryProxyHost === undefined) delete process.env.REGISTRY_PROXY_HOST
        else process.env.REGISTRY_PROXY_HOST = previousRegistryProxyHost
      }
    })

    it('retains the original registry identity and writes a secret once while auditing both attempts', async () => {
      const key = randomUUID()
      const body = { registry_host: 'quay.io', username: 'replay-user', password: 'test-only-password' }
      const original = await fixture.request('POST', 'images/registries', key, body)
      expect(original.status).toBe(201)
      expect(original.body).toMatchObject({ registry_host: 'quay.io', username: 'replay-user' })
      const credential = await fixture.db
        .getRepository(RegistryCredential)
        .findOneByOrFail({ organizationId: fixture.organization.id })
      expect(original.body?.id).toBe(credential.id)
      await fixture.replay('POST', 'images/registries', key, original, body)
      expect(await fixture.db.getRepository(RegistryCredential).count()).toBe(1)
      expect(secret.put).toHaveBeenCalledTimes(1)
      expect(await fixture.db.getRepository(AuditLog).count()).toBe(2)
      expect(original.text).not.toContain(body.password)
      const businessBefore = [...fixture.events]
      const deleteKey = randomUUID()
      const removed = await fixture.request('DELETE', `images/registries/${credential.id}`, deleteKey)
      expect(removed).toMatchObject({ status: 204, text: '' })
      expect(await fixture.db.getRepository(RegistryCredential).count()).toBe(0)
      await fixture.replay('DELETE', `images/registries/${credential.id}`, deleteKey, removed)
      expect(secret.destroy).toHaveBeenCalledTimes(1)
      expect(fixture.events).toEqual(businessBefore)
      expect(await fixture.db.getRepository(AuditLog).count()).toBe(4)
    })

    it('does not append alias history again or delete a replacement alias or image', async () => {
      await registrar.onBoxStarted(
        fixture.organization.id,
        { ref: `${name}:source`, isOrgOwned: true },
        { digest, sizeBytes: 4096 },
      )
      const body = { alias: 'stable', digest }
      const createKey = randomUUID()
      const created = await fixture.request('POST', `${route}/aliases`, createKey, body)
      const historyCount = await fixture.db.getRepository(ImageAliasEvent).count()
      await fixture.replay('POST', `${route}/aliases`, createKey, created, body)
      expect(await fixture.db.getRepository(ImageAliasEvent).count()).toBe(historyCount)
      const deleteKey = randomUUID()
      const removed = await fixture.request('DELETE', `${route}/aliases/stable`, deleteKey)
      await catalog.createAlias(fixture.organization, name, 'stable', { digest }, fixture.userId)
      const replacement = await fixture.db.getRepository(ImageAlias).findOneByOrFail({ name: 'stable' })
      await fixture.replay('DELETE', `${route}/aliases/stable`, deleteKey, removed)
      expect(await fixture.db.getRepository(ImageAlias).findOneByOrFail({ id: replacement.id })).toEqual(replacement)
      const removeKey = randomUUID()
      const imageRemoved = await fixture.request('DELETE', route, removeKey)
      expect(await fixture.db.getRepository(Image).countBy({ deletedAt: IsNull() })).toBe(0)
      await registrar.onBoxStarted(
        fixture.organization.id,
        { ref: `${name}:source`, isOrgOwned: true },
        { digest, sizeBytes: 8192 },
      )
      const replacementImage = await fixture.db
        .getRepository(Image)
        .findOneByOrFail({ organizationId: fixture.organization.id, deletedAt: IsNull() })
      await fixture.replay('DELETE', route, removeKey, imageRemoved)
      expect(await fixture.db.getRepository(Image).findOneByOrFail({ id: replacementImage.id })).toEqual(
        replacementImage,
      )
    })
  })
})
