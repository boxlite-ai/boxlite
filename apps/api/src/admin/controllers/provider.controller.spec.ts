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
      controller.organization('missing', undefined, undefined, undefined, response as never),
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

  it('mounts metadata before the legacy ID route and requires explicit usage selection', async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, limit: 50, observedAt: null })
    const detail = jest.fn().mockResolvedValue(null)
    const module = await Test.createTestingModule({
      controllers: [AdminProviderController],
      providers: [
        { provide: AdminOrganizationOverviewService, useValue: { list, detail } },
        { provide: AdminPlatformOverviewService, useValue: {} },
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
      const page = await fetch(`${base}/metadata?createdFrom=2026-10-01T00:00:00Z`)
      expect(page.status).toBe(200)
      const spec = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
      expect(spec.paths['/api/admin/organizations/metadata'].get?.operationId).toBe('adminListOrganizationMetadata')
      for (const [path, names] of [
        ['/api/admin/organizations/metadata', ['q', 'cursor']],
        ['/api/admin/organizations/{organizationId}/metadata', ['memberCursor', 'boxCursor']],
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
      expect(schemas?.AdminOrganizationMetadata).toMatchObject({
        required: expect.arrayContaining(['createdAt', 'createdBy', 'creator', 'members', 'boxes']),
      })
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: true, createdFrom: '2026-10-01T00:00:00.000Z' }),
      )
      const id = '00000000-0000-4000-8000-000000000001'
      const missing = await fetch(`${base}/${id}/metadata`)
      expect(missing.status).toBe(200)
      expect(await missing.json()).toEqual({ item: null })
      expect(missing.headers.get('cache-control')).toBe('private, no-store')
      expect(detail).toHaveBeenLastCalledWith(id, expect.objectContaining({ metadata: true, includeUsage: false }))
      expect((await fetch(`${base}/${id}/metadata?include=usage`)).status).toBe(200)
      expect(detail).toHaveBeenLastCalledWith(id, expect.objectContaining({ includeUsage: true }))
      expect((await fetch(`${base}/${id}/metadata?include=billing`)).status).toBe(400)
      expect((await fetch(`${base}/not-uuid/metadata`)).status).toBe(400)
      expect(detail).toHaveBeenCalledTimes(2)
      expect((await fetch(`${base}/${id}`)).status).toBe(404)
      for (const path of [
        '/metadata?unknown=value',
        '/not-uuid/metadata',
        `/${id}/metadata?include=billing`,
        `/${id}/metadata?memberCursor=invalid!`,
        `/${id}/metadata?boxCursor=invalid!`,
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
