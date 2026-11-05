import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AddressInfo } from 'node:net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationService } from '../../organization/services/organization.service'
import { AdminOrganizationNestedVirtualizationController } from './organization-nested-virtualization.controller'

// Authentication supplies the context; the real SystemActionGuard enforces the
// protected Admin route, including for organization owners with write grants.
describe('Admin organization nesting HTTP boundary', () => {
  let app: INestApplication
  const id = '00000000-0000-4000-8000-000000000001'
  const organization = { id, nestedVirtualizationEnabled: false }
  const service = {
    findOne: jest.fn(async (value) => (value === id ? organization : null)),
    setNestedVirtualizationEnabled: jest.fn(async (_id, enabled) => {
      organization.nestedVirtualizationEnabled = enabled
    }),
  }
  let base: string
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminOrganizationNestedVirtualizationController],
      providers: [{ provide: OrganizationService, useValue: service }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          const role = request.headers['x-test-role']
          if (!role) throw new UnauthorizedException()
          request.user = {
            role,
            organizationId: id,
            organizationUser: { role: 'owner' },
            apiKey: { permissions: ['write:boxes', 'write:members'] },
          }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/admin/organizations`
  })
  afterAll(async () => app?.close())
  beforeEach(() => {
    organization.nestedVirtualizationEnabled = false
    service.setNestedVirtualizationEnabled.mockClear()
  })
  const request = (method: string, body?: unknown, role: string | undefined = 'admin', selectedId = id) =>
    fetch(`${base}/${selectedId}/nested-virtualization`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  it('reads false by default and lets only an admin enable and disable it', async () => {
    expect(await (await request('GET')).json()).toEqual({ enabled: false })
    for (const enabled of [true, false]) {
      const result = await request('PUT', { enabled })
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ enabled })
      expect(await (await request('GET')).json()).toEqual({ enabled })
    }
  })
  it.each(['user', 'proxy', 'runner', 'health-check'])(
    'denies %s read and write without changing the switch',
    async (role) => {
      for (const method of ['GET', 'PUT'])
        expect((await request(method, method === 'PUT' ? { enabled: true } : undefined, role)).status).toBe(403)
      expect(service.setNestedVirtualizationEnabled).not.toHaveBeenCalled()
    },
  )
  it('denies an unauthenticated write', async () => {
    expect((await request('PUT', { enabled: true }, '')).status).toBe(401)
    expect(service.setNestedVirtualizationEnabled).not.toHaveBeenCalled()
  })
  it.each([{}, { enabled: null }, { enabled: 'true' }, { enabled: 1 }, { enabled: true, extra: true }, []])(
    'rejects malformed input %j before saving',
    async (body) => {
      expect((await request('PUT', body)).status).toBe(400)
      expect(service.setNestedVirtualizationEnabled).not.toHaveBeenCalled()
    },
  )
  it('validates UUIDs and reports missing organizations', async () => {
    expect((await request('GET', undefined, 'admin', 'invalid')).status).toBe(400)
    expect((await request('GET', undefined, 'admin', '00000000-0000-4000-8000-000000000002')).status).toBe(404)
  })
  it('exports typed Admin-only operations without adding public per-box input', () => {
    const spec = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    const path = spec.paths['/api/admin/organizations/{organizationId}/nested-virtualization']
    expect(path.get.operationId).toBe('adminGetOrganizationNestedVirtualization')
    expect(path.put.operationId).toBe('adminSetOrganizationNestedVirtualization')
    expect(spec.components.schemas.AdminOrganizationNestedVirtualization).toMatchObject({
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    })
  })
})
