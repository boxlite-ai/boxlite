import { BoxRequestService } from './box-request.service'
// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  BadRequestException,
  RequestTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { PassportModule } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'node:net'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JwtStrategy } from '../auth/jwt.strategy'
import { CheckpointService } from '../box/services/checkpoint.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxState } from '../box/enums/box-state.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteCheckpointController } from './boxlite-checkpoint.controller'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxService } from '../box/services/box.service'

// Real HTTP, Passport API-key validation and organization permission guards;
// credential storage, membership, Redis and checkpoint persistence are fixtures.
describe('Checkpoint REST authentication and request admission', () => {
  let app: INestApplication
  const organizationId = 'checkpoint-org'
  const checkpoints = { create: jest.fn(), list: jest.fn(), get: jest.fn(), remove: jest.fn() }
  const recovery = { createBox: jest.fn() }
  const boxes = { create: jest.fn() }
  const waiter = { waitForStarted: jest.fn() }
  const limits = { resolveMaxCreatedBoxes: jest.fn() }
  const created = { id: 'target-id', name: 'target', state: BoxState.STARTED, cpu: 4, memory: 8 }
  const record = {
    id: 'checkpoint-id',
    name: 'base',
    sourceBoxId: 'source-id',
    state: 'creating',
    createdAt: new Date('2026-11-06T00:00:00Z'),
    arcPath: 'gs://private/artifact',
    environment: { env: { INTERNAL: 'not-public' } },
    archive: null,
  }

  beforeAll(async () => {
    const entries = new Map<string, string>()
    const redis = {
      get: async (key: string) => entries.get(key) ?? null,
      set: async (key: string, value: string) => {
        entries.set(key, value)
        return 'OK'
      },
      setex: async (key: string, _ttl: number, value: string) => {
        entries.set(key, value)
        return 'OK'
      },
    }
    const users = {
      findOne: async (id: string) => ({
        id,
        role: SystemRole.USER,
        email: 'fixture@example.test',
        emailVerified: true,
      }),
    }
    const config = { get: (key: string) => (key === 'proxy.apiKey' ? 'checkpoint-proxy-key' : 30) }
    const apiKeys = {
      getApiKeyByValue: async (token: string) => {
        if (
          ![
            'checkpoint-write-key',
            'checkpoint-read-key',
            'checkpoint-write-only-key',
            'checkpoint-expired-key',
          ].includes(token)
        )
          throw new UnauthorizedException()
        const permissions =
          token === 'checkpoint-read-key'
            ? [Permission.READ_IMAGES]
            : token === 'checkpoint-write-only-key'
              ? [Permission.WRITE_BOXES]
              : [Permission.WRITE_BOXES]
        return {
          organizationId,
          userId: 'owner',
          name: token,
          permissions,
          expiresAt: token === 'checkpoint-expired-key' ? new Date(0) : undefined,
        }
      },
      updateLastUsedAt: jest.fn().mockResolvedValue(undefined),
    }
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ session: false })],
      controllers: [BoxliteCheckpointController, BoxliteBoxController],
      providers: [
        { provide: BoxRequestService, useValue: {} },
        { provide: CheckpointService, useValue: checkpoints },
        { provide: CheckpointRecoverService, useValue: recovery },
        { provide: BoxService, useValue: boxes },
        { provide: BoxStateWaiterService, useValue: waiter },
        { provide: CommerceBoxLimitService, useValue: limits },
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: async (org: string, userId: string) =>
              org === organizationId ? { organizationId: org, userId, role: OrganizationMemberRole.OWNER } : null,
          },
        },
        {
          provide: ApiKeyStrategy,
          useFactory: () =>
            new ApiKeyStrategy(
              redis as never,
              apiKeys as never,
              users as never,
              config as never,
              { findByApiKey: async () => null } as never,
              { findOneByProxyApiKey: async () => null } as never,
            ),
        },
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              { issuer: 'http://127.0.0.1:1', audience: 'checkpoint-tests', jwksUri: 'http://127.0.0.1:1/jwks' },
              users as never,
              config as never,
              { recordFirstUse: async () => undefined } as never,
            ),
        },
      ],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    checkpoints.create.mockResolvedValue(record)
    checkpoints.get.mockResolvedValue(record)
    checkpoints.list.mockResolvedValue({ checkpoints: [record], nextPageToken: undefined })
    recovery.createBox.mockReset().mockResolvedValue({ id: 'target-id' })
    waiter.waitForStarted.mockReset().mockResolvedValue(created)
    limits.resolveMaxCreatedBoxes.mockReset().mockResolvedValue(2)
  })

  function request(path: string, token?: string, body?: unknown, method?: string) {
    return fetch(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it.each(['pageToken', 'page_token'])('passes the %s pagination cursor to checkpoint storage', async (parameter) => {
    const response = await request(`/v1/checkpoints?${parameter}=next-page`, 'checkpoint-write-key')
    expect(response.status).toBe(200)
    expect(checkpoints.list).toHaveBeenCalledWith(organizationId, 'next-page')
  })

  it('admits scoped capture on canonical, explicit-org and legacy default paths', async () => {
    for (const prefix of ['', `/${organizationId}`, '/default']) {
      const result = await request(`/v1${prefix}/checkpoints`, 'checkpoint-write-key', {
        source_box_id: 'source-id',
        name: 'base',
      })
      expect(result.status).toBe(201)
      expect(await result.json()).toEqual({
        id: record.id,
        name: 'base',
        source_box_id: 'source-id',
        state: 'creating',
        created_at: record.createdAt.toISOString(),
        size_bytes: 0,
      })
    }
    expect(checkpoints.create.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [organizationId, 'source-id', 'base']),
    )
  })

  it('allows reads without exposing the stored environment or object URI', async () => {
    const list = await request('/v1/checkpoints', 'checkpoint-read-key')
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.checkpoints[0]).toMatchObject({ id: record.id, source_box_id: 'source-id' })
    expect(JSON.stringify(body)).not.toMatch(/not-public|gs:\/\/private/)
    expect((await request('/v1/checkpoints/base', 'checkpoint-read-key')).status).toBe(200)
    expect(checkpoints.get).toHaveBeenCalledWith(organizationId, 'base')
  })

  it('rejects missing, unknown and expired credentials before persistence', async () => {
    for (const token of [undefined, 'unknown-key', 'checkpoint-expired-key']) {
      expect((await request('/v1/checkpoints', token, { source_box_id: 'source-id' })).status).toBe(401)
    }
    expect(checkpoints.create).not.toHaveBeenCalled()
  })

  it('requires box write permission for capture, even for an owner key', async () => {
    for (const token of ['checkpoint-read-key', 'checkpoint-proxy-key']) {
      expect((await request('/v1/checkpoints', token, { source_box_id: 'source-id' })).status).toBe(403)
    }
    expect(checkpoints.create).not.toHaveBeenCalled()
  })

  it('reuses the existing box write scope without requiring a new read scope', async () => {
    expect((await request('/v1/checkpoints', 'checkpoint-write-only-key', { source_box_id: 'source-id' })).status).toBe(
      201,
    )
  })

  it('rejects a foreign organization before any checkpoint lookup or capture', async () => {
    expect(
      (await request('/v1/other-org/checkpoints', 'checkpoint-write-key', { source_box_id: 'source-id' })).status,
    ).toBe(403)
    expect((await request('/v1/other-org/checkpoints/base', 'checkpoint-read-key')).status).toBe(403)
    expect(checkpoints.create).not.toHaveBeenCalled()
    expect(checkpoints.get).not.toHaveBeenCalled()
  })

  it('rejects unknown fields and invalid capture arguments before persistence', async () => {
    for (const body of [
      {},
      { source_box_id: '' },
      { source_box_id: 'source', cpus: 4 },
      { source_box_id: 'source', name: '../escape' },
      { source_box_id: 'source', name: 42 },
    ]) {
      expect((await request('/v1/checkpoints', 'checkpoint-write-key', body)).status).toBe(400)
    }
    expect(checkpoints.create).not.toHaveBeenCalled()
  })

  it('creates from a checkpoint on all organization paths and waits for startup', async () => {
    for (const prefix of ['', `/${organizationId}`, '/default']) {
      const result = await request(`/v1${prefix}/boxes`, 'checkpoint-write-key', {
        checkpoint_id: 'base',
        name: 'new-target',
      })
      expect(result.status).toBe(201)
      expect(await result.json()).toMatchObject({ box_id: 'target-id', status: 'running', cpus: 4, memory_mib: 8192 })
    }
    expect(recovery.createBox.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [{ id: organizationId }, 'base', 'new-target', 2]),
    )
    expect(waiter.waitForStarted).toHaveBeenCalledWith('target-id', organizationId, 30)
    expect(boxes.create).not.toHaveBeenCalled()
  })

  it('lets the checkpoint path assign a name when none is given', async () => {
    const result = await request('/v1/boxes', 'checkpoint-write-key', { checkpoint_id: 'base' })
    expect(result.status).toBe(201)
    expect(recovery.createBox).toHaveBeenCalledWith({ id: organizationId }, 'base', undefined, 2)
  })

  it('keeps ordinary creation on the image path', async () => {
    boxes.create.mockResolvedValue(created)
    const result = await request('/v1/boxes', 'checkpoint-write-key', { image: 'alpine:latest', cpus: 2 })
    expect(result.status).toBe(201)
    expect(boxes.create).toHaveBeenCalledTimes(1)
    expect(recovery.createBox).not.toHaveBeenCalled()
  })

  it.each([
    [{ image: 'other:latest' }, 'checkpoint_id and image are mutually exclusive'],
    [{ rootfs_path: '/srv/rootfs' }, 'rootfs_path is local-only; use image instead'],
    [{ cpus: 2 }, 'remove: cpus'],
    [{ env: { OVERRIDE: 'denied' } }, 'remove: env'],
    [{ advanced: { privileged: false } }, 'remove: advanced'],
    [{ detach: true }, 'remove: detach'],
    [{ cpus: 2, memory_mib: 512 }, 'remove: cpus, memory_mib'],
    [{ box_id: 'target' }, 'property box_id should not exist'],
  ])('rejects checkpoint creation combined with %j without creating anything', async (extra, message) => {
    const result = await request('/v1/boxes', 'checkpoint-write-key', { checkpoint_id: 'base', ...extra })
    expect(result.status).toBe(400)
    expect(JSON.stringify((await result.json()).message)).toContain(message)
    expect(limits.resolveMaxCreatedBoxes).not.toHaveBeenCalled()
    expect(recovery.createBox).not.toHaveBeenCalled()
    expect(boxes.create).not.toHaveBeenCalled()
  })

  it('rejects invalid checkpoint selectors and names before admission', async () => {
    for (const body of [
      { checkpoint_id: '' },
      { checkpoint_id: null },
      { checkpoint_id: 42 },
      { checkpoint_id: 'x'.repeat(129) },
      { checkpoint_id: 'base', name: '../outside' },
      { checkpoint_id: 'base', name: '' },
      { checkpoint_id: 'base', name: 'x'.repeat(129) },
      { checkpoint_id: 'base', name: null },
    ]) {
      expect((await request('/v1/boxes', 'checkpoint-write-key', body)).status).toBe(400)
    }
    expect(recovery.createBox).not.toHaveBeenCalled()
    expect(boxes.create).not.toHaveBeenCalled()
  })

  it('enforces credentials, Box write scope and tenant isolation before checkpoint admission', async () => {
    for (const [token, status] of [
      [undefined, 401],
      ['unknown-key', 401],
      ['checkpoint-expired-key', 401],
      ['checkpoint-read-key', 403],
      ['checkpoint-proxy-key', 403],
    ] as const) {
      expect((await request('/v1/boxes', token, { checkpoint_id: 'base' })).status).toBe(status)
    }
    expect((await request('/v1/other-org/boxes', 'checkpoint-write-key', { checkpoint_id: 'base' })).status).toBe(403)
    expect(limits.resolveMaxCreatedBoxes).not.toHaveBeenCalled()
    expect(recovery.createBox).not.toHaveBeenCalled()
  })

  it('no longer routes the import and recovery paths', async () => {
    for (const prefix of ['', `/${organizationId}`]) {
      const result = await request(`/v1${prefix}/boxes/import`, 'checkpoint-write-key', { checkpoint_id: 'base' })
      expect(result.status).toBe(404)
    }
    expect((await request('/v1/boxes/target/recover', 'checkpoint-write-key', { checkpoint_id: 'base' })).status).toBe(
      404,
    )
    expect(recovery.createBox).not.toHaveBeenCalled()
    expect(boxes.create).not.toHaveBeenCalled()
  })

  it.each([
    new RequestTimeoutException({ message: 'Still importing', code: 'import_pending' }),
    new BadRequestException({ message: 'Archive import failed', code: 'checkpoint_import_failed' }),
  ])('preserves a newly admitted Box identity on wait failure: %s', async (error) => {
    waiter.waitForStarted.mockRejectedValue(error)
    const result = await request('/v1/boxes', 'checkpoint-write-key', { checkpoint_id: 'base' })
    expect(result.status).toBe(error.getStatus())
    expect(await result.json()).toMatchObject({ ...(error.getResponse() as object), boxId: 'target-id' })
    expect(recovery.createBox).toHaveBeenCalledTimes(1)
  })

  it('does not attach an identity when admission itself fails', async () => {
    recovery.createBox.mockRejectedValue(new BadRequestException('Checkpoint is not ready'))
    const result = await request('/v1/boxes', 'checkpoint-write-key', { checkpoint_id: 'base' })
    expect(result.status).toBe(400)
    expect(await result.json()).not.toHaveProperty('boxId')
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
  })

  it('surfaces the checkpoint capability gate from admission', async () => {
    recovery.createBox.mockRejectedValue(new ServiceUnavailableException('Checkpoints are not enabled'))
    const result = await request('/v1/boxes', 'checkpoint-write-key', { checkpoint_id: 'base' })
    expect(result.status).toBe(503)
    expect(boxes.create).not.toHaveBeenCalled()
  })

  it('requires Box write scope for deletion and validates force without bypassing tenant guards', async () => {
    expect((await request('/v1/checkpoints/base', 'checkpoint-write-key', undefined, 'DELETE')).status).toBe(204)
    expect(checkpoints.remove).toHaveBeenLastCalledWith(organizationId, 'base', false)
    expect((await request('/v1/checkpoints/base?force=true', 'checkpoint-write-key', undefined, 'DELETE')).status).toBe(
      204,
    )
    expect(checkpoints.remove).toHaveBeenLastCalledWith(organizationId, 'base', true)
    checkpoints.remove.mockClear()
    expect((await request('/v1/checkpoints/base?force=yes', 'checkpoint-write-key', undefined, 'DELETE')).status).toBe(
      400,
    )
    expect((await request('/v1/checkpoints/base', 'checkpoint-read-key', undefined, 'DELETE')).status).toBe(403)
    expect((await request('/v1/other-org/checkpoints/base', 'checkpoint-write-key', undefined, 'DELETE')).status).toBe(
      403,
    )
    expect(checkpoints.remove).not.toHaveBeenCalled()
  })
})
