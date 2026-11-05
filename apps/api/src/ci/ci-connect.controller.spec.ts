/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { PassportModule } from '@nestjs/passport'
import { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { CiConnectController } from './ci-connect.controller'
import { CiConnectService } from './ci-connect.service'
import { CiSettingsController } from './ci-settings.controller'
import { CiSettingsService } from './ci-settings.service'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'

describe('CI connect HTTP authorization boundary', () => {
  let app: INestApplication, base: string
  const org = randomUUID()
  const service = {
    start: jest.fn(),
    poll: jest.fn(),
    cancel: jest.fn(),
    configuration: jest.fn(),
    startWeb: jest.fn(),
    completeWeb: jest.fn(),
    selectWeb: jest.fn(),
  }
  const settings = { get: jest.fn(), update: jest.fn() }
  const permissions = ['write:boxes', 'delete:boxes']
  const redis = { get: async () => null, set: async () => undefined, setex: async () => undefined }
  beforeAll(async () => {
    const keyService = {
      getApiKeyByValue: async (token: string) => ({
        organizationId: org,
        userId: token,
        name: 'test',
        permissions: token.endsWith('limited') ? ['write:boxes'] : permissions,
      }),
      updateLastUsedAt: async () => undefined,
    }
    const userService = {
      findOne: async (id: string) => ({
        id,
        email: 'fixture@example.test',
        role: id.startsWith('admin') ? 'admin' : 'user',
      }),
    }
    const organizationService = { findOne: async (id: string) => (id === org ? { id } : null) }
    const memberService = {
      findOne: async (_: string, id: string) => ({ role: id.startsWith('member') ? 'member' : 'owner' }),
    }
    const guard = new OrganizationActionGuard(organizationService as any, memberService as any, new Reflector())
    ;(guard as any).redis = redis
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [CiConnectController, CiSettingsController],
      providers: [
        { provide: CiConnectService, useValue: service },
        { provide: CiSettingsService, useValue: settings },
        {
          provide: ApiKeyStrategy,
          useFactory: () =>
            new ApiKeyStrategy(
              redis as any,
              keyService as any,
              userService as any,
              { get: () => undefined } as any,
              {} as any,
              {} as any,
            ),
        },
        CombinedAuthGuard,
      ],
    })
      .overrideGuard(OrganizationActionGuard)
      .useValue(guard)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    service.start.mockReset().mockResolvedValue({ status: 'pending' })
    service.poll.mockReset().mockResolvedValue({ status: 'pending' })
    service.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
    service.configuration.mockReset().mockResolvedValue({ web_connect_available: true })
    service.startWeb.mockReset().mockResolvedValue({ status: 'pending' })
    service.completeWeb.mockReset().mockResolvedValue({ status: 'connected' })
    service.selectWeb.mockReset().mockResolvedValue({ status: 'connected' })
    settings.get.mockReset().mockResolvedValue({ available: true, max_concurrent_jobs: null })
    settings.update.mockReset().mockResolvedValue({ available: true, max_concurrent_jobs: 2 })
  })
  async function request(
    key: string,
    path = `/${org}/ci/connect`,
    method = 'POST',
    body: unknown = {
      github_account: 'alice',
      follow_installation: true,
      allow_public_repositories: false,
    },
  ) {
    return fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: method === 'DELETE' || method === 'GET' ? undefined : JSON.stringify(body),
    })
  }
  it('protects account settings with the real owner and delegated-scope guards', async () => {
    expect((await request('owner', `/${org}/ci/settings`, 'GET')).status).toBe(200)
    expect((await request('owner', `/${org}/ci/settings`, 'PATCH', { max_concurrent_jobs: 2 })).status).toBe(200)
    const reads = settings.get.mock.calls.length,
      writes = settings.update.mock.calls.length
    for (const key of ['member', 'owner-limited', 'admin-limited']) {
      expect((await request(key, `/${org}/ci/settings`, 'GET')).status).toBe(403)
      expect((await request(key, `/${org}/ci/settings`, 'PATCH', { max_concurrent_jobs: 2 })).status).toBe(403)
    }
    expect((await request('owner', `/${randomUUID()}/ci/settings`, 'PATCH', { max_concurrent_jobs: 2 })).status).toBe(
      403,
    )
    expect(settings.get).toHaveBeenCalledTimes(reads)
    expect(settings.update).toHaveBeenCalledTimes(writes)
  })
  it('validates nullable account limits and rejects repository-policy injection', async () => {
    for (const value of [null, 0, 2])
      expect((await request('owner', `/${org}/ci/settings`, 'PATCH', { max_concurrent_jobs: value })).status).toBe(200)
    expect(settings.update.mock.calls.map((call) => call[1])).toEqual([null, 0, 2])
    for (const body of [
      {},
      { max_concurrent_jobs: -1 },
      { max_concurrent_jobs: '2' },
      { max_concurrent_jobs: 1.5 },
      { max_concurrent_jobs: Number.MAX_SAFE_INTEGER + 1 },
      { max_concurrent_jobs: 2, repository_id: 123 },
    ])
      expect((await request('owner', `/${org}/ci/settings`, 'PATCH', body)).status).toBe(400)
    expect(settings.update).toHaveBeenCalledTimes(3)
  })
  it('protects browser configuration, start and complete with owner and delegated-scope guards', async () => {
    const id = randomUUID(),
      body = { code: 'web-code', state: id + '.' + 'A'.repeat(43) }
    expect((await request('owner', `/${org}/ci/connect/configuration`, 'GET')).status).toBe(200)
    expect(
      (
        await request('owner', `/${org}/ci/connect/web`, 'POST', {
          account_type: 'User',
          follow_installation: true,
          allow_public_repositories: false,
        })
      ).status,
    ).toBe(201)
    expect((await request('owner', `/${org}/ci/connect/${id}/complete`, 'POST', body)).status).toBe(201)
    for (const actor of ['member', 'owner-limited', 'admin-limited']) {
      expect((await request(actor, `/${org}/ci/connect/configuration`, 'GET')).status).toBe(403)
      expect((await request(actor, `/${org}/ci/connect/web`)).status).toBe(403)
      expect((await request(actor, `/${org}/ci/connect/${id}/complete`, 'POST', body)).status).toBe(403)
    }
    for (const invalid of [
      { code: '', state: body.state },
      { ...body, state: 'forged' },
      { ...body, installation_id: 123 },
      { ...body, code: 'x'.repeat(2049) },
    ])
      expect((await request('owner', `/${org}/ci/connect/${id}/complete`, 'POST', invalid)).status).toBe(400)
    expect(service.startWeb).toHaveBeenCalledTimes(1)
    expect(service.completeWeb).toHaveBeenCalledTimes(1)
    expect(service.completeWeb.mock.calls[0][0]).toMatchObject({ organizationId: org, userId: 'owner' })
  })
  it('guards and validates manual selection and installation callbacks separately', async () => {
    const id = randomUUID(),
      state = id + '.' + 'A'.repeat(43)
    expect((await request('owner', `/${org}/ci/connect/${id}/select`, 'POST', { installation_id: 123 })).status).toBe(
      201,
    )
    expect(service.selectWeb).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: org }), id, 123)
    expect(
      (await request('owner', `/${org}/ci/connect/${id}/installation`, 'POST', { installation_id: 123, state })).status,
    ).toBe(201)
    expect(service.selectWeb).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: org }), id, 123, state)
    for (const actor of ['member', 'owner-limited', 'admin-limited'])
      for (const route of ['select', 'installation'])
        expect(
          (await request(actor, `/${org}/ci/connect/${id}/${route}`, 'POST', { installation_id: 123, state })).status,
        ).toBe(403)
    for (const installation_id of [0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1])
      expect((await request('owner', `/${org}/ci/connect/${id}/select`, 'POST', { installation_id })).status).toBe(400)
    expect(
      (await request('owner', `/${org}/ci/connect/${id}/installation`, 'POST', { installation_id: 123 })).status,
    ).toBe(400)
    expect(
      (await request('owner', `/${org}/ci/connect/${id}/select`, 'POST', { installation_id: 123, state })).status,
    ).toBe(400)
    expect(service.selectWeb).toHaveBeenCalledTimes(2)
  })
  it('permits the owner and forwards only validated connect input', async () => {
    expect((await request('owner')).status).toBe(201)
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(service.start.mock.calls[0][0]).toMatchObject({ organizationId: org, userId: 'owner' })
  })
  it('denies members even with both Box scopes, and denies an owner or admin with limited scopes', async () => {
    for (const key of ['member', 'owner-limited', 'admin-limited']) {
      expect((await request(key)).status).toBe(403)
      expect((await request(key, `/${org}/ci/connect/${randomUUID()}/poll`, 'POST', {})).status).toBe(403)
      expect((await request(key, `/${org}/ci/connect/${randomUUID()}`, 'DELETE')).status).toBe(403)
    }
    expect(service.start).not.toHaveBeenCalled()
    expect(service.poll).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
  })
  it('retains the explicit platform-admin exception but refuses cross-org ordinary keys', async () => {
    expect((await request('admin')).status).toBe(201)
    expect((await request('owner', `/${randomUUID()}/ci/connect`)).status).toBe(403)
    expect(service.start).toHaveBeenCalledTimes(1)
  })
  it('rejects forged policy and unknown fields before reaching the service', async () => {
    for (const body of [
      { github_account: '../other', follow_installation: true, allow_public_repositories: false },
      { github_account: 'alice', follow_installation: false, allow_public_repositories: false },
      { github_account: 'alice', follow_installation: true, allow_public_repositories: false, installation_id: 123 },
    ]) {
      expect((await request('owner', undefined, 'POST', body)).status).toBe(400)
    }
    expect(service.start).not.toHaveBeenCalled()
  })
})
