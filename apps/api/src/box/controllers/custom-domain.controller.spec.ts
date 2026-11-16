/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { CustomDomainController } from './custom-domain.controller'
import { CustomDomainService } from '../services/custom-domain.service'

const org = '00000000-0000-4000-8000-000000000001'
const id = '00000000-0000-4000-8000-000000000002'

describe('custom domain HTTP authorization', () => {
  let app: INestApplication
  let base: string
  let permissions: string[] = []
  let member = true
  const service = {
    list: jest.fn().mockResolvedValue({ domains: [] }),
    get: jest.fn().mockResolvedValue({ id }),
    create: jest.fn().mockResolvedValue({ id }),
    verify: jest.fn().mockResolvedValue({ id }),
    delete: jest.fn(),
    prepare: jest.fn().mockResolvedValue({ id }),
    advance: jest.fn().mockResolvedValue({ id }),
  }
  beforeAll(async () => {
    const guard = new OrganizationResourceActionGuard(
      { findOne: async () => ({ id: org }) } as never,
      { findOne: async () => (member ? { role: 'member', assignedRoles: [{ permissions }] } : null) } as never,
      new Reflector(),
    )
    Object.assign(guard, { redis: { get: async () => null, set: async () => undefined } })
    const module = await Test.createTestingModule({
      controllers: [CustomDomainController],
      providers: [{ provide: CustomDomainService, useValue: service }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest()
          if (req.headers.authorization !== 'Bearer test') return false
          req.user = req.headers['x-machine']
            ? { role: 'proxy' }
            : { role: 'user', userId: 'member', organizationId: org }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue(guard)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    permissions = ['write:boxes']
    member = true
  })
  async function call(method = 'GET', path = '', headers = {}) {
    return fetch(`${base}/organizations/${org}/custom-domains${path}`, {
      method,
      headers: { authorization: 'Bearer test', ...headers },
    })
  }
  it('denies absent credentials, membership, write permission and machine identities', async () => {
    expect((await call('GET', '', { authorization: '' })).status).toBe(403)
    member = false
    expect((await call()).status).toBe(403)
    member = true
    permissions = ['read:boxes']
    expect((await call()).status).toBe(403)
    permissions = ['write:boxes']
    expect((await call('GET', '', { 'x-machine': 'proxy' })).status).toBe(403)
    expect(service.list).not.toHaveBeenCalled()
  })
  it('permits each management operation with Box write permission and uses async verification status', async () => {
    expect((await call()).status).toBe(200)
    expect((await call('GET', `/${id}`)).status).toBe(200)
    expect((await call('POST')).status).toBe(201)
    expect((await call('POST', `/${id}/verify`)).status).toBe(202)
    expect((await call('POST', `/${id}/prepare`)).status).toBe(202)
    expect((await call('POST', `/${id}/advance`)).status).toBe(202)
    expect((await call('DELETE', `/${id}`)).status).toBe(204)
    expect(service.verify).toHaveBeenCalledWith(org, id)
    expect(service.delete).toHaveBeenCalledWith(org, id)
  })
  it('rejects malformed configuration IDs before service dispatch', async () => {
    expect((await call('GET', '/not-a-uuid')).status).toBe(400)
    expect(service.get).not.toHaveBeenCalled()
  })
})
