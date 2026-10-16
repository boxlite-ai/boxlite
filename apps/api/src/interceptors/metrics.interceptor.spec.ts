/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const mockCapture = jest.fn()
jest.mock('posthog-node', () => ({
  PostHog: jest.fn(() => ({ capture: mockCapture, shutdown: jest.fn() })),
}))

import type { INestApplication } from '@nestjs/common'
import { ConflictException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { ImageController } from '../image/controllers/image.controller'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { MetricsInterceptor } from './metrics.interceptor'

const ORGANIZATION = { id: 'org-123', imageCountLimit: 20 }
const CONFIG: Record<string, string> = {
  version: '0.0.0-test',
  'posthog.apiKey': 'phc_test',
  'posthog.host': 'https://posthog.test',
  'posthog.environment': 'test',
}

/**
 * The interceptor picks the event by `request.route.path`, so the case it
 * matches has to be the path the router actually reports. That is why these
 * run the real controller behind a real router rather than a hand-built
 * request: a hand-built one would only prove the switch agrees with itself.
 */
describe('MetricsInterceptor', () => {
  let app: INestApplication
  let catalog: { delete: jest.Mock }

  beforeEach(async () => {
    mockCapture.mockReset()
    catalog = { delete: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      controllers: [ImageController],
      providers: [{ provide: ImageCatalogService, useValue: catalog }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = {
            userId: 'user-1',
            organizationId: ORGANIZATION.id,
            organization: ORGANIZATION,
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()

    const configService = {
      get: (key: string) => CONFIG[key],
      getOrThrow: (key: string) => CONFIG[key],
    } as unknown as TypedConfigService

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalInterceptors(new MetricsInterceptor(configService))
    await app.listen(0)
  })

  afterEach(async () => {
    await app?.close()
  })

  const deleteImage = async (encodedRef: string): Promise<Response> => {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api/images/${encodedRef}`, { method: 'DELETE' })
  }

  it('captures a removed image under the reference the caller named', async () => {
    const response = await deleteImage('quay.io%2Facme%2Fapp')

    expect(response.status).toBe(204)
    expect(mockCapture).toHaveBeenCalledTimes(1)
    const [captured] = mockCapture.mock.calls[0]
    expect(captured).toMatchObject({
      distinctId: 'user-1',
      event: 'api_image_deleted',
      groups: { organization: ORGANIZATION.id },
      properties: { image_id_or_ref: 'quay.io/acme/app', status_code: 204, boxlite_version: '0.0.0-test' },
    })
    // Every `/images` route used to be flagged deprecated. The catalog is the
    // current API, so the flag must not come back on its events.
    expect(captured.properties).not.toHaveProperty('is_deprecated')
  })

  it('captures a refused removal as a failed deletion with its status', async () => {
    catalog.delete.mockRejectedValue(new ConflictException('still in use by box-1'))

    const response = await deleteImage('quay.io%2Facme%2Fapp')

    expect(response.status).toBe(409)
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'api_image_deletion_failed',
        properties: expect.objectContaining({
          image_id_or_ref: 'quay.io/acme/app',
          status_code: 409,
          error: 'still in use by box-1',
        }),
      }),
    )
  })
})
