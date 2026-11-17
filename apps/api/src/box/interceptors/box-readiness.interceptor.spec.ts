/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { INestApplication, Logger, RequestTimeoutException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { AddressInfo } from 'node:net'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, Subject } from 'rxjs'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BoxliteBoxController } from '../../boxlite-rest/boxlite-box.controller'
import { CommerceBoxLimitService } from '../../boxlite-rest/commerce-box-limit.service'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'
import { captureRequestTiming, requestTiming } from '../../common/utils/request-timing.util'
import { BoxService } from '../services/box.service'
import { BoxStateWaiterService } from '../services/box-state-waiter.service'
import { CheckpointRecoverService } from '../services/checkpoint-recover.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxReadinessError } from '../errors/box-readiness.error'
import { BoxReadinessInterceptor } from './box-readiness.interceptor'

describe('Cloud readiness metrics at actual REST routes', () => {
  const organization = { id: 'org-1' }
  const started = {
    id: 'box-1',
    organizationId: organization.id,
    state: BoxState.STARTED,
    desiredState: BoxDesiredState.STARTED,
  }
  let app: INestApplication
  let observed: Readonly<Record<string, string>>[]
  let dispose: () => void
  let allow: boolean
  let arrivals: string[]
  let boxService: { create: jest.Mock; findOneByIdOrName: jest.Mock; start: jest.Mock; toBoxDto: jest.Mock }
  let waiter: { waitForStarted: jest.Mock }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    allow = true
    arrivals = []
    observed = []
    dispose = subscribeBusinessEvents((event) => {
      if (event['event.name'].startsWith('cloud.')) observed.push(event)
    })
    boxService = {
      create: jest.fn().mockResolvedValue({ ...started, state: BoxState.CREATING }),
      findOneByIdOrName: jest
        .fn()
        .mockResolvedValue({ ...started, state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED }),
      start: jest.fn().mockResolvedValue({ ...started, state: BoxState.STARTING }),
      toBoxDto: jest.fn(async (box) => box),
    }
    waiter = { waitForStarted: jest.fn().mockResolvedValue(started) }
    const module = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        { provide: BoxService, useValue: boxService },
        { provide: BoxStateWaiterService, useValue: waiter },
        { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => undefined } },
        { provide: CheckpointRecoverService, useValue: {} },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          arrivals.push(requestTiming(context.switchToHttp().getRequest()).requestedAt.toISOString())
          context.switchToHttp().getRequest().user = {
            role: SystemRole.USER,
            userId: 'user-1',
            organizationId: organization.id,
            organization,
          }
          return allow
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use(captureRequestTiming)
    await app.listen(0, '127.0.0.1')
  })

  afterEach(async () => {
    await app?.close()
    dispose()
    jest.restoreAllMocks()
  })

  function post(path: string, body: unknown = {}): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch('http://127.0.0.1:' + address.port + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it.each(['/api/v1/boxes', '/api/v1/cloud/boxes'])(
    'records create readiness at %s without a PostHog configuration',
    async (path) => {
      const response = await post(path)
      expect(response.status).toBe(201)
      expect((await response.json()).status).toBe('running')
      expect(observed.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
      expect(observed[0]['operation.id']).toBe(observed[1]['operation.id'])
      expect(observed[0]['operation.requested_at']).toBe(arrivals[0])
      expect(observed[1]).toMatchObject({
        'event.name': 'cloud.box.create',
        'operation.result': 'success',
        'operation.scope': 'rest_api',
        'box.id': started.id,
        'organization.id': organization.id,
        'user.id': 'user-1',
      })
      expect(Number(observed[1]['operation.duration_ms'])).toBeGreaterThanOrEqual(0)
    },
  )

  it('waits for readiness before recording terminal success', async () => {
    let release!: (box: typeof started) => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    waiter.waitForStarted.mockImplementation(() => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const pending = post('/api/v1/boxes')
    try {
      await waiting
      expect(observed.map((event) => event['event.outcome'])).toEqual(['requested'])
    } finally {
      release(started)
    }
    expect((await pending).status).toBe(201)
    expect(observed.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
  })

  it('records separate attempts for concurrent starts of the same Box', async () => {
    const responses = await Promise.all([post('/api/v1/boxes/box-1/start'), post('/api/v1/boxes/box-1/start')])
    expect(responses.map((response) => response.status)).toEqual([201, 201])
    const attempts = observed.filter((event) => event['event.outcome'] === 'requested')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]['operation.id']).not.toBe(attempts[1]['operation.id'])
    for (const attempt of attempts) {
      expect(
        observed
          .filter((event) => event['operation.id'] === attempt['operation.id'])
          .map((event) => event['event.outcome']),
      ).toEqual(['requested', 'success'])
    }
  })

  it.each([
    [new RequestTimeoutException('private-timeout'), 408, 'timeout'],
    [new BoxReadinessError('private-runtime-error'), 400, 'service_error'],
    [new Error('private-database-error'), 500, 'service_error'],
  ])('preserves the HTTP failure and records a sanitized category: %s', async (error, status, result) => {
    waiter.waitForStarted.mockRejectedValue(error)
    expect((await post('/api/v1/boxes')).status).toBe(status)
    expect(observed[1]).toMatchObject({ 'operation.result': result, 'box.id': started.id })
    expect(JSON.stringify(observed)).not.toContain('private-')
  })

  it('separates validation refusals from service failures', async () => {
    expect((await post('/api/v1/boxes', { unexpected: 'private-value' })).status).toBe(400)
    expect(boxService.create).not.toHaveBeenCalled()
    expect(observed[1]['operation.result']).toBe('user_error')
    expect(observed[1]).not.toHaveProperty('box.id')
    expect(JSON.stringify(observed)).not.toContain('private-value')
  })

  it('excludes requests refused by guards before interception', async () => {
    allow = false
    expect((await post('/api/v1/boxes')).status).toBe(403)
    expect(observed).toEqual([])
  })

  it('records cancellation once when the handler observable is unsubscribed', () => {
    const request = { user: { userId: 'user-1', organizationId: organization.id }, get: () => undefined }
    const context = {
      getHandler: () => BoxliteBoxController.prototype.createBox,
      switchToHttp: () => ({ getRequest: () => request }),
    }
    const stream = new Subject<unknown>()
    const subscription = new BoxReadinessInterceptor(new Reflector())
      .intercept(context as never, { handle: () => stream })
      .subscribe()
    subscription.unsubscribe()
    expect(observed.map((event) => event['event.outcome'])).toEqual(['requested', 'exception'])
    expect(observed[1]['operation.result']).toBe('cancelled')
  })

  it('accounts for a synchronous handler error without changing its identity', async () => {
    const failure = new Error('private-handler-error')
    const request = { user: { userId: 'user-1', organizationId: organization.id }, get: () => undefined }
    const context = {
      getHandler: () => BoxliteBoxController.prototype.createBox,
      switchToHttp: () => ({ getRequest: () => request }),
    }
    const stream = new BoxReadinessInterceptor(new Reflector()).intercept(context as never, {
      handle: () => {
        throw failure
      },
    })
    await expect(lastValueFrom(stream)).rejects.toBe(failure)
    expect(observed[1]['operation.result']).toBe('service_error')
  })
})
