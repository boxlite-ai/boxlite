/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const mockCapture = jest.fn()
jest.mock('../analytics/services/consent-bound-posthog', () => ({
  ConsentBoundPostHog: jest.fn(() => ({
    deliver: mockCapture,
    shutdown: jest.fn(),
    on: jest.fn(),
  })),
}))

import type { INestApplication } from '@nestjs/common'
import { ConflictException, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { VolumeController } from '../box/controllers/volume.controller'
import { VolumeService } from '../box/services/volume.service'
import { BoxliteVolumeController } from '../boxlite-rest/boxlite-volume.controller'
import { BoxliteImageController } from '../boxlite-rest/boxlite-image.controller'
import { ImageController } from '../image/controllers/image.controller'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { MetricsInterceptor } from './metrics.interceptor'
import { AnalyticsConsentService } from '../analytics/services/analytics-consent.service'
import { grantedAnalyticsConsent } from '../../test/granted-analytics-consent'
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
const volume = { id: 'volume-1', createdAt: new Date(1), updatedAt: new Date(1) }
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
  let catalog: { delete: jest.Mock; deleteAlias: jest.Mock }

  beforeEach(async () => {
    mockCapture.mockReset()
    catalog = { delete: jest.fn().mockResolvedValue(undefined), deleteAlias: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      controllers: [
        ImageController,
        OrganizationController,
        BoxliteImageController,
        VolumeController,
        BoxliteVolumeController,
      ],
      providers: [
        AnalyticsService,
        { provide: AnalyticsConsentService, useValue: grantedAnalyticsConsent },
        { provide: TypedConfigService, useValue: { get: (key: string) => CONFIG[key] } },
        { provide: ImageCatalogService, useValue: catalog },
        { provide: VolumeService, useValue: { create: async () => volume, waitForReady: async () => volume } },
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
          const req = context.switchToHttp().getRequest()
          req.user = {
            role: 'user',
            organizationUser: req.get('x-test-member')
              ? { userId: 'user-1', organizationId: ORGANIZATION.id }
              : undefined,
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
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    app.useGlobalInterceptors(new MetricsInterceptor(configService, moduleRef.get(AnalyticsService)))
    await app.listen(0)
  })

  afterEach(async () => {
    await app?.close()
  })

  it.each(['/api/images', '/api/v1/images', '/api/v1/default/images'])(
    'tracks removal of an alias through %s with only bounded properties',
    async (base) => {
      const address = app.getHttpServer().address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}${base}/private-image/aliases/private-tag`, {
        method: 'DELETE',
        headers: { 'x-test-member': '1', 'x-boxlite-source': 'sdk' },
      })
      expect(response.status).toBe(204)
      expect(catalog.deleteAlias).toHaveBeenCalledWith(ORGANIZATION, 'private-image', 'private-tag')
      expect(mockCapture).toHaveBeenCalledTimes(1)
      expect(mockCapture.mock.calls[0][0].properties).toEqual({
        'api.operation': 'image.alias.delete',
        'client.source': 'sdk',
        'http.status_class': '2xx',
      })
    },
  )

  it.each([
    ['/api/volumes', { name: 'workspace' }, 200, 'standard'],
    ['/api/v1/volumes', { storageBackend: 'standard' }, 201, 'standard'],
    ['/api/v1/default/volumes', { storageBackend: 'performance', instance: 'private-instance' }, 201, 'performance'],
    ['/api/volumes', { name: '/invalid', storageBackend: 'performance' }, 400, 'performance'],
    ['/api/volumes', { storageBackend: 'private-value' }, 400, undefined],
    ['/api/volumes', { storageBackend: null }, 400, undefined],
  ] as const)('records only the requested volume class for POST %s %j', async (path, body, status, backend) => {
    const address = app.getHttpServer().address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-member': '1' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(status)
    const events = mockCapture.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event === 'cloud.api.operation')
    expect(events.map((event) => event.properties)).toEqual([
      {
        'api.operation': 'volume.create',
        'client.source': 'unattributed',
        'http.status_class': status < 400 ? '2xx' : '4xx',
        ...(backend && { 'volume.storage_backend': backend }),
      },
    ])
  })

  it('returns the alias response while its PostHog transfer is pending', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    mockCapture.mockImplementationOnce(() => pending)
    try {
      const address = app.getHttpServer().address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/images/ref/aliases/tag`, {
        method: 'DELETE',
        headers: { 'x-test-member': '1' },
      })
      expect(response.status).toBe(204)
      expect(mockCapture).toHaveBeenCalledTimes(1)
    } finally {
      finish()
    }
  })

  it('drops an interrupted response even when the alias operation later succeeds', async () => {
    let admitted!: () => void
    let complete!: () => void
    const entered = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    catalog.deleteAlias.mockImplementationOnce(() => {
      admitted()
      return pending
    })
    const server = app.getHttpServer()
    const incoming = once(server, 'request')
    const req = httpRequest({
      port: (server.address() as AddressInfo).port,
      hostname: '127.0.0.1',
      path: '/api/images/ref/aliases/tag',
      method: 'DELETE',
      headers: { 'x-test-member': '1' },
    })
    req.on('error', () => {}) // Destroying the client connection reports ECONNRESET.
    req.end()
    const [, response] = await incoming
    const closed = once(response, 'close')
    try {
      await entered
      req.destroy()
      await closed
    } finally {
      complete()
    }
    // Drain the handler microtasks before observing analytics.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(mockCapture).not.toHaveBeenCalled()
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
      body: JSON.stringify({ name: 'Example', defaultRegionId: 'us' }),
    })
    expect(response.status).toBe(201)
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$groupidentify',
        properties: expect.objectContaining({
          $group_type: 'organization',
          $group_key: 'new-org',
          $group_set: expect.objectContaining({ name: 'Example', environment: 'test' }),
        }),
      }),
    )
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ event: 'api_organization_created' }))
  })

  it.each(['posthog.apiKey', 'posthog.host'])('preserves responses without %s', async (missing) => {
    const config = {
      get: (key: string) => (key === missing ? undefined : CONFIG[key]),
      getOrThrow: (key: string) => CONFIG[key],
    }
    const disabled = new AnalyticsService(config as never, grantedAnalyticsConsent)
    const interceptor = new MetricsInterceptor(config as never, disabled)
    const next = { handle: jest.fn(() => of('response')) }
    const context = {
      switchToHttp: () => {
        throw new Error('disabled analytics must not inspect the request')
      },
    }
    expect(disabled.enabled).toBe(false)
    await expect(lastValueFrom(interceptor.intercept(context as never, next))).resolves.toBe('response')
    disabled.capture({ event: 'ignored', distinctId: 'user-1' }, { users: ['user-1'], organizations: [] })
    disabled.groupIdentify({ groupType: 'organization', groupKey: 'ignored' })
    await disabled.handleOrganizationCreatedEvent({ id: 'ignored' } as never)
    await disabled.onApplicationShutdown()
    expect(mockCapture).not.toHaveBeenCalled()
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
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('still in use by box-1')
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'api_image_deletion_failed',
        properties: expect.objectContaining({
          image_id_or_ref: 'quay.io/acme/app',
          status_code: 409,
        }),
      }),
    )
  })
})
