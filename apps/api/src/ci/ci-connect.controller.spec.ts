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
import { CiManagementController } from './ci-management.controller'
import { CiNativeWorkers } from './ci-native-workers'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

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
    completeInstallation: jest.fn(),
    selectAccount: jest.fn(),
    getWeb: jest.fn(),
    repositories: jest.fn(),
  }
  const settings = {
    get: jest.fn(),
    update: jest.fn(),
    deleteConnection: jest.fn(),
    updateConnection: jest.fn(),
    capacity: jest.fn(),
    repositories: jest.fn(),
  }
  const workers = { list: jest.fn() }
  const permissions = ['write:boxes', 'delete:boxes']
  const redis = { get: async () => null, set: async () => undefined, setex: async () => undefined }
  beforeAll(async () => {
    const keyService = {
      getApiKeyByValue: async (token: string) => ({
        organizationId: org,
        userId: token,
        name: 'test',
        permissions: token.endsWith('limited') ? ['write:boxes'] : token === 'member-reader' ? [] : permissions,
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
    const readGuard = new OrganizationResourceActionGuard(
      organizationService as any,
      memberService as any,
      new Reflector(),
    )
    ;(readGuard as any).redis = redis
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [CiConnectController, CiSettingsController, CiManagementController],
      providers: [
        { provide: CiConnectService, useValue: service },
        { provide: CiSettingsService, useValue: settings },
        { provide: CiNativeWorkers, useValue: workers },
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
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue(readGuard)
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
    service.completeInstallation.mockReset().mockResolvedValue({ status: 'selection_required' })
    service.selectAccount.mockReset().mockResolvedValue({ status: 'selection_required' })
    service.getWeb.mockReset().mockResolvedValue({ status: 'selection_required' })
    settings.get.mockReset().mockResolvedValue({ available: true, max_concurrent_jobs: null })
    settings.update.mockReset().mockResolvedValue({ available: true, max_concurrent_jobs: 2 })
    settings.deleteConnection.mockReset().mockResolvedValue(undefined)
    settings.updateConnection.mockReset().mockResolvedValue(undefined)
    settings.capacity
      .mockReset()
      .mockResolvedValue({ available: true, used: 2, effective_limit: 5, commerce_limit: 5, max_concurrent_jobs: null })
    workers.list.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 })
  })
  async function request(
    key: string,
    path = `/${org}/ci/connect`,
    method = 'POST',
    body: unknown = {
      github_account: 'alice',
      follow_installation: true,
      allow_private_repositories: false,
    },
  ) {
    return fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: method === 'DELETE' || method === 'GET' ? undefined : JSON.stringify(body),
    })
  }
  it('allows scoped Box readers to list JIT Boxes and bounds pagination', async () => {
    const response = await request('member-reader', `/${org}/ci/runners?page=2&limit=10`, 'GET')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ capacity: { used: 2, effective_limit: 5 } })
    expect(settings.capacity).toHaveBeenLastCalledWith(org)
    expect(settings.get).not.toHaveBeenCalled()
    expect(workers.list).toHaveBeenLastCalledWith(org, 2, 10, undefined)
    expect((await request('owner', '/ci/runners', 'GET')).status).toBe(200)
    expect(workers.list).toHaveBeenLastCalledWith(org, 1, 25, undefined)
    expect((await request('member-reader', `/${org}/ci/runners?name=runner%20A`, 'GET')).status).toBe(200)
    expect(workers.list).toHaveBeenLastCalledWith(org, 1, 25, 'runner A')
    expect(settings.capacity).toHaveBeenLastCalledWith(org)
    for (const query of [
      'page=0',
      'page=1.5',
      'limit=201',
      'limit=-1',
      'page=9007199254740991',
      'organization=other',
      'name=a&name=b',
      'name=' + 'x'.repeat(129),
    ])
      expect((await request('owner', `/${org}/ci/runners?${query}`, 'GET')).status).toBe(400)
    expect((await request('owner-limited', `/${org}/ci/runners`, 'GET')).status).toBe(200)
    expect((await request('owner', `/${randomUUID()}/ci/runners`, 'GET')).status).toBe(403)
    expect(workers.list).toHaveBeenCalledTimes(4)
    expect(settings.capacity).toHaveBeenCalledTimes(4)
  })
  it('requires owner Box permissions for both repository contexts and bounds a page to 100', async () => {
    const id = randomUUID()
    for (const path of [
      `/${org}/ci/connections/${id}/repositories`,
      `/${org}/ci/connect/${id}/accounts/789/repositories`,
    ]) {
      expect((await request('member-reader', path, 'GET')).status).toBe(403)
      expect((await request('owner-limited', path, 'GET')).status).toBe(403)
      for (const query of ['page=0', 'limit=0', 'limit=101', 'installation_id=11', 'limit=bad']) {
        expect((await request('owner', `${path}?${query}`, 'GET')).status).toBe(400)
      }
      expect((await request('owner', `${path}?page=2&limit=100`, 'GET')).status).toBe(200)
    }
    expect(settings.repositories).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org, userId: 'owner' }),
      id,
      2,
      100,
    )
    expect(service.repositories).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org, userId: 'owner' }),
      id,
      789,
      2,
      100,
    )
  })
  it('requires owner and both write/delete scopes before disconnecting a validated binding', async () => {
    const binding = randomUUID()
    expect((await request('owner', `/${org}/ci/connections/${binding}`, 'DELETE')).status).toBe(204)
    expect((await request('owner', `/ci/connections/${binding}`, 'DELETE')).status).toBe(204)
    expect(settings.deleteConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: org, userId: 'owner' }),
      binding,
    )
    for (const key of ['member', 'member-reader', 'owner-limited', 'admin-limited'])
      expect((await request(key, `/${org}/ci/connections/${binding}`, 'DELETE')).status).toBe(403)
    expect((await request('owner', `/${randomUUID()}/ci/connections/${binding}`, 'DELETE')).status).toBe(403)
    expect((await request('owner', `/${org}/ci/connections/not-a-uuid`, 'DELETE')).status).toBe(400)
    expect(settings.deleteConnection).toHaveBeenCalledTimes(2)
  })
  it('updates only validated connection policy with owner and delegated-scope authorization', async () => {
    const binding = randomUUID()
    expect(
      (await request('owner', `/${org}/ci/connections/${binding}`, 'PATCH', { allow_private_repositories: true }))
        .status,
    ).toBe(204)
    expect(
      (await request('owner', `/ci/connections/${binding}`, 'PATCH', { allow_private_repositories: false })).status,
    ).toBe(204)
    expect(settings.updateConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: org, userId: 'owner' }),
      binding,
      false,
    )
    for (const actor of ['member', 'member-reader', 'owner-limited', 'admin-limited'])
      expect(
        (await request(actor, `/${org}/ci/connections/${binding}`, 'PATCH', { allow_private_repositories: true }))
          .status,
      ).toBe(403)
    for (const body of [
      {},
      { allow_private_repositories: 'true' },
      { allow_private_repositories: null },
      { allow_private_repositories: true, generation: 2 },
      { allow_private_repositories: false, account_type: 'Organization' },
    ])
      expect((await request('owner', `/${org}/ci/connections/${binding}`, 'PATCH', body)).status).toBe(400)
    expect(
      (
        await request('owner', `/${randomUUID()}/ci/connections/${binding}`, 'PATCH', {
          allow_private_repositories: true,
        })
      ).status,
    ).toBe(403)
    expect(
      (await request('owner', `/${org}/ci/connections/invalid`, 'PATCH', { allow_private_repositories: true })).status,
    ).toBe(400)
    expect(settings.updateConnection).toHaveBeenCalledTimes(2)
  })
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
          allow_private_repositories: false,
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
  it('protects authenticated resume and account selection with the existing owner and key guards', async () => {
    const id = randomUUID(),
      body = { account_id: 789, allow_private_repositories: false }
    expect((await request('owner', `/${org}/ci/connect/${id}`, 'GET')).status).toBe(200)
    expect((await request('owner', `/${org}/ci/connect/${id}/accounts`, 'POST', body)).status).toBe(201)
    expect(service.selectAccount).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org, userId: 'owner' }),
      id,
      body,
    )
    for (const key of ['member', 'member-reader', 'owner-limited', 'admin-limited']) {
      expect((await request(key, `/${org}/ci/connect/${id}`, 'GET')).status).toBe(403)
      expect((await request(key, `/${org}/ci/connect/${id}/accounts`, 'POST', body)).status).toBe(403)
    }
    for (const invalid of [
      {},
      { ...body, account_id: '789' },
      { ...body, account_id: -1 },
      { ...body, account_id: 1.5 },
      { ...body, account_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, allow_private_repositories: 'false' },
      { ...body, app_client_id: 'foreign' },
      { ...body, installation_id: 321 },
    ])
      expect((await request('owner', `/${org}/ci/connect/${id}/accounts`, 'POST', invalid)).status).toBe(400)
    expect(service.selectAccount).toHaveBeenCalledTimes(1)
    expect(
      (
        await request('owner', `/${org}/ci/connect/web`, 'POST', {
          follow_installation: true,
          allow_private_repositories: false,
          select_account: true,
        })
      ).status,
    ).toBe(201)
    expect(service.startWeb).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: org }), {
      follow_installation: true,
      allow_private_repositories: false,
      select_account: true,
    })
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
    expect(service.completeInstallation).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: org }),
      id,
      123,
      state,
    )
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
    expect(service.selectWeb).toHaveBeenCalledTimes(1)
    expect(service.completeInstallation).toHaveBeenCalledTimes(1)
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
      { github_account: '../other', follow_installation: true, allow_private_repositories: false },
      { github_account: 'alice', follow_installation: false, allow_private_repositories: false },
      { github_account: 'alice', follow_installation: true, allow_private_repositories: false, installation_id: 123 },
    ]) {
      expect((await request('owner', undefined, 'POST', body)).status).toBe(400)
    }
    expect(service.start).not.toHaveBeenCalled()
  })
})
