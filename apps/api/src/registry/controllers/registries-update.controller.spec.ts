/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Configuration, RegistriesApi } from '@boxlite-ai/api-client'
import { AddressInfo } from 'node:net'
import { AuditInterceptor } from '../../audit/interceptors/audit.interceptor'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { RegistriesService } from '../services/registries.service'
import { RegistriesController } from './registries.controller'

const ORG = '00000000-0000-4000-8000-000000000001'
const ID = '00000000-0000-4000-8000-000000000002'
const LOGIN = { username: 'replacement-bot', password: 'replacement-token' }

describe('Registry credential update HTTP boundary', () => {
  let app: INestApplication
  let baseUrl: string
  let permissions: OrganizationResourcePermission[]
  const service = { update: jest.fn() }
  const audit = { createLog: jest.fn(), updateLog: jest.fn() }

  beforeAll(async () => {
    // Exercise the real resource guard with cached organization/membership
    // data; only authentication and the rate limiter are outside this test.
    const guard = Object.assign(new OrganizationResourceActionGuard({} as never, {} as never, new Reflector()), {
      redis: {
        get: async (key: string) =>
          JSON.stringify(key === `organization:${ORG}` ? { id: ORG } : { role: OrganizationMemberRole.OWNER }),
      },
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistriesController],
      providers: [{ provide: RegistriesService, useValue: service }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = {
            role: SystemRole.USER,
            userId: 'test-user',
            email: 'test@example.test',
            organizationId: ORG,
            apiKey: { organizationId: ORG, permissions },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue(guard)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), audit as never, { get: jest.fn() } as never))
    await app.listen(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/images/registries`
  })

  beforeEach(() => {
    jest.clearAllMocks()
    permissions = [OrganizationResourcePermission.WRITE_REGISTRIES]
    service.update.mockResolvedValue({
      id: ID,
      organizationId: ORG,
      kind: RegistryCredentialKind.BASIC,
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: LOGIN.username,
      secretVersion: 'private-secret-version',
      createdBy: 'creator',
      createdAt: new Date('2026-01-01'),
    })
    audit.createLog.mockResolvedValue({ id: 'audit-1' })
    audit.updateLog.mockResolvedValue(undefined)
  })

  afterAll(async () => {
    await app?.close()
  })

  const update = (body: unknown, id = ID) =>
    fetch(`${baseUrl}/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('accepts write permission and returns a password-free credential with stable scope', async () => {
    const response = await update(LOGIN)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: ID,
      kind: 'basic',
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: LOGIN.username,
      createdBy: 'creator',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(service.update).toHaveBeenCalledWith(ORG, ID, LOGIN)
    expect(audit.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: ID, metadata: { body: { username: LOGIN.username } } }),
    )
    expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain(LOGIN.password)
  })

  it('accepts the generated client update request over HTTP', async () => {
    const api = new RegistriesApi(new Configuration({ basePath: baseUrl.replace('/images/registries', '') }))
    const response = await api.updateRegistryCredential(ID, LOGIN, ORG)
    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({
      id: ID,
      username: LOGIN.username,
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
    })
    expect(service.update).toHaveBeenCalledWith(ORG, ID, LOGIN)
  })

  it.each([OrganizationResourcePermission.READ_REGISTRIES, OrganizationResourcePermission.DELETE_REGISTRIES])(
    'refuses %s without write permission',
    async (permission) => {
      permissions = [permission]
      expect((await update(LOGIN)).status).toBe(403)
      expect(service.update).not.toHaveBeenCalled()
    },
  )

  it.each([
    {},
    { username: 'bot' },
    { password: 'token' },
    { ...LOGIN, username: null },
    { ...LOGIN, password: '' },
    { ...LOGIN, password: 12345 },
    { ...LOGIN, username: 'x'.repeat(256) },
    { ...LOGIN, password: 'x'.repeat(8193) },
    { ...LOGIN, registryHost: 'quay.io' },
    { ...LOGIN, repositoryPrefix: 'other/' },
    { ...LOGIN, secretVersion: 'injected' },
  ])('refuses invalid or scope-changing input %# before calling the service', async (body) => {
    const response = await update(body)
    expect(response.status).toBe(400)
    expect(service.update).not.toHaveBeenCalled()
    const error = JSON.stringify(await response.json())
    expect(error).not.toContain(LOGIN.password)
    expect(error).not.toContain('12345')
  })

  it('validates the credential UUID', async () => {
    expect((await update(LOGIN, 'invalid-id')).status).toBe(400)
    expect(service.update).not.toHaveBeenCalled()
  })
})
