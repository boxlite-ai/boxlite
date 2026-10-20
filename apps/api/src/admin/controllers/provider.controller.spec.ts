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
  it('returns 404 for an organization missing from the read projection', async () => {
    const controller = new AdminProviderController({ detail: jest.fn().mockResolvedValue(null) } as never, {} as never)
    const response = { setHeader: jest.fn() }

    await expect(
      controller.organization(
        '00000000-0000-4000-8000-000000000001',
        undefined,
        undefined,
        undefined,
        {},
        response as never,
      ),
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

  it('reuses organization routes for metadata and activation while retaining legacy defaults', async () => {
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
      const page = await fetch(`${base}?view=metadata&createdFrom=2026-10-01T00:00:00Z`)
      expect(page.status).toBe(200)
      expect(page.headers.get('x-boxlite-admin-capabilities')).toBe('organization-metadata-v1')
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
      expect(schemas?.AdminOrganizationDetail).toMatchObject({
        required: expect.arrayContaining(['members', 'boxes']),
        properties: { createdAt: { type: 'string' }, activation: { nullable: true } },
      })
      expect((schemas?.AdminOrganizationDetail as { required: string[] }).required).not.toContain('createdAt')
      expect((schemas?.AdminOrganizationDetail as { required: string[] }).required).not.toContain('activation')
      expect(
        spec.paths['/api/admin/organizations'].get?.parameters
          ?.slice(0, 3)
          .map((parameter) => 'name' in parameter && parameter.name),
      ).toEqual(['q', 'cursor', 'limit'])
      expect(
        spec.paths['/api/admin/organizations/{organizationId}'].get?.parameters
          ?.slice(0, 4)
          .map((parameter) => 'name' in parameter && parameter.name),
      ).toEqual(['organizationId', 'memberCursor', 'boxCursor', 'sectionLimit'])
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: true, createdFrom: '2026-10-01T00:00:00.000Z' }),
      )
      const id = '00000000-0000-4000-8000-000000000001'
      const missing = await fetch(`${base}/${id}?view=metadata`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('cache-control')).toBe('private, no-store')
      expect(detail).toHaveBeenLastCalledWith(id, expect.objectContaining({ metadata: true, includeUsage: false }))
      detail.mockResolvedValue({ organizationId: id })
      const selected = await fetch(`${base}/${id}?view=metadata&include=usage,activation`)
      expect(selected.status).toBe(200)
      expect(selected.headers.get('x-boxlite-admin-capabilities')).toBe('organization-metadata-v1')
      expect(await selected.json()).toEqual({ organizationId: id })
      expect(detail).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ includeUsage: true, includeActivation: true }),
      )
      expect((await fetch(`${base}/${id}?view=metadata&include=activation`)).status).toBe(200)
      expect(detail).toHaveBeenLastCalledWith(
        id,
        expect.objectContaining({ includeUsage: false, includeActivation: true }),
      )
      expect((await fetch(`${base}/${id}`)).status).toBe(200)
      expect(detail).toHaveBeenLastCalledWith(id, { memberLimit: 50, boxLimit: 50 })
      expect((await fetch(`${base}/${id}/metadata`)).status).toBe(404)
      expect((await fetch(`${base}/${id}/activation`)).status).toBe(404)
      const capability = await fetch(`http://127.0.0.1:${address.port}/api/admin/component-identities`)
      expect(capability.headers.get('x-boxlite-admin-capabilities')).toBe('organization-metadata-v1')
      expect(await capability.json()).toEqual(identities)
      for (const path of [
        '?view=metadata&unknown=value',
        '?view=unsupported',
        '/not-uuid?view=metadata',
        `/${id}?view=metadata&include=billing`,
        `/${id}?view=metadata&include=activation,activation`,
        `/${id}?view=metadata&memberCursor=invalid!`,
        `/${id}?view=metadata&boxCursor=invalid!`,
      ]) {
        const invalid = await fetch(`${base}${path}`)
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toMatchObject({
          statusCode: 400,
          code: 'invalid_organization_metadata_query',
          message: 'Invalid organization metadata query',
        })
      }
      const legacyInvalid = await fetch(`${base}/not-uuid`)
      expect(legacyInvalid.status).toBe(400)
      expect(await legacyInvalid.json()).not.toHaveProperty('code')
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
