import { NotFoundException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
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
