/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { EntityNotFoundError } from 'typeorm'
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
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

const describeWithRedis = process.env.REDIS_HOST ? describe : describe.skip
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
