/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const mockCapture = jest.fn()
const mockGroupIdentify = jest.fn()
jest.mock('posthog-node', () => ({
  PostHog: jest.fn(() => ({
    capture: mockCapture,
    groupIdentify: mockGroupIdentify,
    shutdown: jest.fn(),
    on: jest.fn(),
  })),
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
import { AnalyticsService } from '../analytics/services/analytics.service'
import { AuthGuard } from '@nestjs/passport'
import { of, lastValueFrom } from 'rxjs'
import { OrganizationController } from '../organization/controllers/organization.controller'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { OrganizationBoxLimitsService } from '../organization/services/organization-box-limits.service'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { SystemActionGuard } from '../auth/system-action.guard'
import { OrGuard } from '../auth/or.guard'
import { UserService } from '../user/user.service'

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
    mockGroupIdentify.mockReset()
    catalog = { delete: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      controllers: [ImageController, OrganizationController],
      providers: [
        AnalyticsService,
        { provide: TypedConfigService, useValue: { get: (key: string) => CONFIG[key] } },
        { provide: ImageCatalogService, useValue: catalog },
        {
          provide: OrganizationService,
          useValue: {
            create: jest.fn(async (input) => ({
              id: 'new-org',
              name: input.name,
              createdBy: 'user-1',
              createdAt: new Date(1),
              updatedAt: new Date(1),
              users: [],
            })),
          },
        },
        { provide: OrganizationUserService, useValue: {} },
        { provide: OrganizationInvitationService, useValue: {} },
        { provide: OrganizationBoxLimitsService, useValue: { resolve: jest.fn(async () => ({})) } },
        { provide: UserService, useValue: { findOne: jest.fn(async () => ({ emailVerified: true })) } },
      ],
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
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { userId: 'user-1', organizationId: ORGANIZATION.id }
          return true
        },
      })
      .overrideGuard(OrganizationActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SystemActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OrGuard)
      .useValue({ canActivate: () => true })
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
    app.useGlobalInterceptors(new MetricsInterceptor(configService, moduleRef.get(AnalyticsService)))
    await app.listen(0)
  })

  afterEach(async () => {
    await app?.close()
  })

  const deleteImage = async (encodedRef: string): Promise<Response> => {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api/images/${encodedRef}`, { method: 'DELETE' })
  }

  it('identifies a created organization through the shared analytics client', async () => {
    const address = app.getHttpServer().address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/api/organizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Example' }),
    })
    expect(response.status).toBe(201)
    expect(mockGroupIdentify).toHaveBeenCalledWith(
      expect.objectContaining({
        groupType: 'organization',
        groupKey: 'new-org',
        properties: expect.objectContaining({ name: 'Example', environment: 'test' }),
      }),
    )
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ event: 'api_organization_created' }))
  })

  it.each(['posthog.apiKey', 'posthog.host'])('preserves responses without %s', async (missing) => {
    const config = {
      get: (key: string) => (key === missing ? undefined : CONFIG[key]),
      getOrThrow: (key: string) => CONFIG[key],
    }
    const disabled = new AnalyticsService(config as never)
    const interceptor = new MetricsInterceptor(config as never, disabled)
    const next = { handle: jest.fn(() => of('response')) }
    const context = {
      switchToHttp: () => {
        throw new Error('disabled analytics must not inspect the request')
      },
    }
    expect(disabled.enabled).toBe(false)
    await expect(lastValueFrom(interceptor.intercept(context as never, next))).resolves.toBe('response')
    disabled.capture({ event: 'ignored', distinctId: 'user-1' })
    disabled.groupIdentify({ groupType: 'organization', groupKey: 'ignored' })
    await disabled.handleOrganizationCreatedEvent({ id: 'ignored' } as never)
    await disabled.onApplicationShutdown()
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockGroupIdentify).not.toHaveBeenCalled()
  })

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
