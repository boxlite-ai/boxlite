import { NotFoundException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter'
import { AdminOrganizationOverviewService } from '../services/organization-overview.service'
import { AdminPlatformOverviewService } from '../services/platform-overview.service'
import { AdminProviderController } from './provider.controller'

describe('AdminProviderController', () => {
  it('limits a policy reader to bounded registrations and exact-org all-state counts', async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, limit: 200, observedAt: null })
    const module = await Test.createTestingModule({
      controllers: [AdminProviderController],
      providers: [
        { provide: AdminOrganizationOverviewService, useValue: { list } },
        { provide: AdminPlatformOverviewService, useValue: { regions: jest.fn() } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = { role: 'email-policy-reader' }
          return true
        },
      })
      .compile()
    const app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
    try {
      const { port } = app.getHttpServer().address() as AddressInfo
      const base = `http://127.0.0.1:${port}/api/admin`
      const id = '00000000-0000-4000-8000-000000000001'
      expect(
        (
          await fetch(
            `${base}/organizations?boxCountScope=all&createdFrom=2026-10-01T00:00:00Z&createdTo=2026-10-02T00:00:00Z`,
          )
        ).status,
      ).toBe(200)
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ boxCountScope: 'all' }))
      expect((await fetch(`${base}/organizations?boxCountScope=all&organizationId=${id}`)).status).toBe(200)
      expect((await fetch(`${base}/organizations?boxCountScope=all`)).status).toBe(403)
      expect(
        (
          await fetch(
            `${base}/organizations?boxCountScope=all&createdFrom=2026-01-01T00:00:00Z&createdTo=2026-10-02T00:00:00Z`,
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(
            `${base}/organizations?boxCountScope=all&createdFrom=2026-10-01T00:00:00Z&createdTo=2026-11-01T00:00:00Z`,
          )
        ).status,
      ).toBe(200)
      const calls = list.mock.calls.length
      for (const query of [
        'boxCountScope=all&q=ab&createdFrom=2026-10-01T00:00:00Z&createdTo=2026-10-02T00:00:00Z',
        'boxCountScope=all&createdFrom=2026-10-01T00:00:00Z',
        'boxCountScope=all&createdFrom=2026-10-01T00:00:00Z&createdTo=2026-11-01T00:00:00.001Z',
        `organizationId=${id}&boxCountScope=all&createdTo=2026-10-02T00:00:00Z`,
      ])
        expect((await fetch(`${base}/organizations?${query}`)).status).toBe(403)
      expect(list).toHaveBeenCalledTimes(calls)
      expect((await fetch(`${base}/organizations?organizationId=${id}&boxCountScope=all`)).status).toBe(200)
      expect((await fetch(`${base}/organizations?organizationId=${id}`)).status).toBe(403)
      expect((await fetch(`${base}/organizations?boxCountScope=all`)).status).toBe(403)
      expect((await fetch(`${base}/regions`)).status).toBe(403)
      expect((await fetch(`${base}/organizations/${id}`)).status).toBe(403)
    } finally {
      await app.close()
    }
  })
  it('returns 404 for an organization missing from the read projection', async () => {
    const controller = new AdminProviderController({ detail: jest.fn().mockResolvedValue(null) } as never, {} as never)
    const response = { setHeader: jest.fn() }

    await expect(
      controller.organization('00000000-0000-4000-8000-000000000001', {}, response as never),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
  })

  it('mounts provider reads under admin and removes the consumer-named route', async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminProviderController],
      providers: [
        {
          provide: AdminOrganizationOverviewService,
          useValue: {
            list: jest.fn().mockResolvedValue({ items: [], nextCursor: null, limit: 50, observedAt: null }),
          },
        },
        { provide: AdminPlatformOverviewService, useValue: {} },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SystemActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    const app: INestApplication = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
    try {
      const address = app.getHttpServer().address() as AddressInfo
      const canonical = await fetch(`http://127.0.0.1:${address.port}/api/admin/organizations`)
      const formerConsumerRoute = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/backoffice/v1/organizations`,
      )

      expect(canonical.status).toBe(200)
      expect(formerConsumerRoute.status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('extends organization routes directly and reads optional sections only when requested', async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, limit: 50, observedAt: null })
    const detail = jest.fn().mockResolvedValue(null)
    const identities = { api: { version: 'test' }, runners: [], observedAt: '2026-10-20T01:00:00.000Z' }
    const module = await Test.createTestingModule({
      controllers: [AdminProviderController],
      providers: [
        { provide: AdminOrganizationOverviewService, useValue: { list, detail } },
        { provide: AdminPlatformOverviewService, useValue: { componentIdentities: () => identities } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SystemActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    const app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0)
    try {
      const address = app.getHttpServer().address() as AddressInfo
      const base = `http://127.0.0.1:${address.port}/api/admin/organizations`
      const page = await fetch(`${base}?createdFrom=2026-10-01T00:00:00Z`)
      expect(page.status).toBe(200)
      expect(page.headers.get('x-boxlite-admin-capabilities')).toBeNull()
      const spec = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
      expect(spec.paths['/api/admin/organizations'].get?.operationId).toBe('adminListOrganizationsOverview')
      expect(spec.paths['/api/admin/organizations/{organizationId}'].get?.operationId).toBe(
        'adminGetOrganizationOverview',
      )
      expect(Object.keys(spec.paths).filter((path) => /\/(metadata|activation)$/.test(path))).toEqual([])
      for (const [path, names] of [
        ['/api/admin/organizations', ['q', 'cursor']],
        ['/api/admin/organizations/{organizationId}', ['memberCursor', 'boxCursor']],
      ] as const) {
        for (const name of names) {
          expect(spec.paths[path].get?.parameters).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name, schema: expect.objectContaining({ type: 'string' }) }),
            ]),
          )
        }
      }
      const schemas = spec.components?.schemas
      expect(schemas?.AdminOrganizationCreator).toMatchObject({
        properties: { email: { type: 'string', nullable: true } },
      })
      expect(schemas?.AdminOrganizationCreator).not.toHaveProperty('properties.emailVerified')
      expect(schemas?.AdminOrganizationDetail).toMatchObject({
        properties: { creator: { allOf: [{ $ref: '#/components/schemas/AdminOrganizationCreator' }] } },
      })
      for (const name of ['AdminOrganizationOverview']) {
        const creator = (schemas?.[name] as { properties: { creator: { allOf: { $ref: string }[] } } }).properties
          .creator
        const creatorName = creator.allOf[0].$ref.split('/').at(-1) ?? ''
        expect(schemas?.[creatorName]).toHaveProperty('properties.emailVerified.type', 'boolean')
      }
      expect(schemas?.AdminOrganizationDetail).toMatchObject({
        required: expect.arrayContaining(['members', 'boxes']),
        properties: { createdAt: { type: 'string' }, activation: { nullable: true } },
      })
      expect((schemas?.AdminOrganizationDetail as { required: string[] }).required).toContain('createdAt')
      expect((schemas?.AdminOrganizationDetail as { required: string[] }).required).not.toContain('activation')
      for (const path of ['/api/admin/organizations', '/api/admin/organizations/{organizationId}'])
        expect(spec.paths[path].get?.parameters).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'view' })]),
        )
      expect(
        spec.paths['/api/admin/organizations'].get?.parameters?.map(
          (parameter) => 'name' in parameter && parameter.name,
        ),
      ).toEqual(['q', 'cursor', 'limit', 'createdTo', 'createdFrom', 'boxCountScope', 'organizationId'])
      expect(
        spec.paths['/api/admin/organizations/{organizationId}'].get?.parameters?.map(
          (parameter) => 'name' in parameter && parameter.name,
        ),
      ).toEqual(['organizationId', 'memberCursor', 'boxCursor', 'sectionLimit', 'include'])
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ createdFrom: '2026-10-01T00:00:00.000Z' }))
      expect((await fetch(`${base}?projection=registration`)).status).toBe(400)
      expect(spec.paths['/api/admin/organizations/registrations']).toBeUndefined()
      expect(spec.paths['/api/admin/organizations'].get?.responses['200']).toMatchObject({
        content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminOrganizationOverviewPage' } } },
      })
      expect((await fetch(`${base}?boxCountScope=all&q=example&cursor=next&limit=20`)).status).toBe(200)
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ boxCountScope: 'all', query: 'example', cursor: 'next', limit: 20 }),
      )
      expect((await fetch(`${base}/registrations`)).status).toBe(400)
      expect((await fetch(`${base}?boxCountScope=all`)).status).toBe(200)
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ boxCountScope: 'all' }))
      const id = '00000000-0000-4000-8000-000000000001'
      const missing = await fetch(`${base}/${id}`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('cache-control')).toBe('private, no-store')
      expect(detail).toHaveBeenLastCalledWith(id, expect.objectContaining({ includeUsage: false }))
      detail.mockResolvedValue({ organizationId: id })
      const selected = await fetch(`${base}/${id}?include=usage,activation`)
      expect(selected.status).toBe(200)
      expect(selected.headers.get('x-boxlite-admin-capabilities')).toBeNull()
      expect(await selected.json()).toEqual({ organizationId: id })
      expect(detail).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ includeUsage: true, includeActivation: true }),
      )
      expect((await fetch(`${base}/${id}?include=activation`)).status).toBe(200)
      expect(detail).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ includeUsage: false, includeActivation: true }),
      )
      expect((await fetch(`${base}/${id}`)).status).toBe(200)
      expect(detail).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ memberLimit: 50, boxLimit: 50, includeUsage: false, includeActivation: false }),
      )
      expect((await fetch(`${base}/${id}/metadata`)).status).toBe(404)
      expect((await fetch(`${base}/${id}/activation`)).status).toBe(404)
      const capability = await fetch(`http://127.0.0.1:${address.port}/api/admin/component-identities`)
      expect(capability.headers.get('x-boxlite-admin-capabilities')).toBeNull()
      expect(await capability.json()).toEqual(identities)
      for (const path of [
        '?unknown=value',
        '?projection=',
        '?projection=unknown',
        '?projection=registration&projection=registration',
        '?projection=registration&boxCountScope=all',
        '?view=metadata',
        '?limit=0',
        '?createdFrom=2026-10-02T00:00:00Z&createdTo=2026-10-01T00:00:00Z',
        '/not-uuid',
        `/${id}?include=billing`,
        `/${id}?include=activation,activation`,
        `/${id}?memberCursor=invalid!`,
        `/${id}?boxCursor=invalid!`,
      ]) {
        const invalid = await fetch(`${base}${path}`)
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toMatchObject({
          statusCode: 400,
          code: 'invalid_organization_query',
          message: 'Invalid organization query',
        })
      }
    } finally {
      await app.close()
    }
  })

  // organization.id and job.id are uuid columns, so an unvalidated path parameter reaches
  // Postgres and comes back as `invalid input syntax for type uuid` — a 500 for what is a
  // malformed request. region.id and box.id are character varying and take no such pipe.
  it.each(['organizations', 'jobs'])(
    'rejects a malformed uuid in /%s/:id before it reaches the database',
    async (route) => {
      const service = jest.fn().mockResolvedValue(null)
      const module = await Test.createTestingModule({
        controllers: [AdminProviderController],
        providers: [
          { provide: AdminOrganizationOverviewService, useValue: { detail: service } },
          { provide: AdminPlatformOverviewService, useValue: { job: service } },
        ],
      })
        .overrideGuard(CombinedAuthGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(SystemActionGuard)
        .useValue({ canActivate: () => true })
        .compile()
      const app: INestApplication = module.createNestApplication()
      app.setGlobalPrefix('api')
      await app.listen(0)
      try {
        const address = app.getHttpServer().address() as AddressInfo
        const malformed = await fetch(`http://127.0.0.1:${address.port}/api/admin/${route}/not-a-uuid`)

        expect(malformed.status).toBe(400)
        expect(service).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )
})
