import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'node:net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationService } from '../../organization/services/organization.service'
import { AdminOrganizationAppHostingPermissionsController } from './organization-app-hosting-permissions.controller'

describe('Admin organization App Hosting permissions', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  let row: { appHostingPermissions: string[] }
  const repository = {
    findOne: jest.fn(async ({ where }) => (where.id === id ? { ...row } : null)),
    update: jest.fn(async (_entity, _id, changes) => Object.assign(row, changes)),
  }
  const redis = { del: jest.fn(async () => 1) }
  const service = Object.assign(Object.create(OrganizationService.prototype), {
    organizationRepository: {
      ...repository,
      manager: {
        transaction: (work: (manager: unknown) => unknown) =>
          work({
            findOne: (_entity: unknown, options: unknown) => repository.findOne(options as { where: { id: string } }),
            update: repository.update,
          }),
      },
    },
    redis,
  })
  let app: INestApplication
  let base: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminOrganizationAppHostingPermissionsController],
      providers: [
        {
          provide: OrganizationService,
          useValue: {
            getAppHostingPermissions: service.getAppHostingPermissions.bind(service),
            setAppHostingPermissions: service.setAppHostingPermissions.bind(service),
          },
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          const role = request.headers['x-test-role']
          if (!role) throw new UnauthorizedException()
          request.user = { role, organizationUser: { role: 'owner' } }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/admin/organizations`
  })
  afterAll(async () => app?.close())
  beforeEach(() => {
    row = { appHostingPermissions: [] }
    jest.clearAllMocks()
  })
  const request = (method: string, body?: unknown, role = 'admin', target = id) =>
    fetch(`${base}/${target}/app-hosting-permissions`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(role ? { 'X-Test-Role': role } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('replaces the whole grant, returning the canonical list on repeated saves and reads', async () => {
    for (const scopes of [['delete:apps', 'read:apps', 'delete:apps'], ['read:apps', 'delete:apps'], []]) {
      const saved = await request('PUT', { appHostingPermissions: scopes })
      expect(saved.status).toBe(200)
      const expected = { appHostingPermissions: scopes.length ? ['read:apps', 'delete:apps'] : [] }
      expect(await saved.json()).toEqual(expected)
      expect(await (await request('GET')).json()).toEqual(expected)
      expect(redis.del).toHaveBeenCalledWith(`organization:${id}`)
    }
  })

  it('keeps grants restricted to system administrators', async () => {
    for (const role of ['', 'user']) {
      for (const method of ['GET', 'PUT']) {
        const body = method === 'PUT' ? { appHostingPermissions: ['write:apps'] } : undefined
        expect((await request(method, body, role)).status).toBe(role ? 403 : 401)
      }
    }
    expect(repository.update).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { appHostingPermissions: null },
    { appHostingPermissions: 'read:apps' },
    { appHostingPermissions: ['write:boxes'] },
    { appHostingPermissions: [], extra: true },
  ])('rejects invalid input %j before saving', async (body) => {
    expect((await request('PUT', body)).status).toBe(400)
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('distinguishes invalid organization IDs and missing organizations', async () => {
    for (const method of ['GET', 'PUT']) {
      const body = method === 'PUT' ? { appHostingPermissions: [] } : undefined
      expect((await request(method, body, 'admin', 'invalid')).status).toBe(400)
      expect((await request(method, body, 'admin', '00000000-0000-4000-8000-000000000002')).status).toBe(404)
    }
  })
})
