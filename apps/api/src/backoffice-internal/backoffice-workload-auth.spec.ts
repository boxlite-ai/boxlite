/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'node:crypto'
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { TypedConfigService } from '../config/typed-config.service'
import {
  BackofficeWorkloadAuthenticator,
  BackofficeWorkloadAuthGuard,
  BackofficeWorkloadRouteScope,
  RequireBackofficeWorkloadRoute,
} from './backoffice-workload-auth'

const CURRENT_TOKEN = 'synthetic-current-workload-token'
const NEXT_TOKEN = 'synthetic-next-workload-token'
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

function config(enabled = true) {
  const values: Record<string, unknown> = {
    'backofficeInternal.enabled': enabled,
    'backofficeInternal.readTokenDigests.current': enabled ? digest(CURRENT_TOKEN) : undefined,
    'backofficeInternal.readTokenDigests.next': enabled ? digest(NEXT_TOKEN) : undefined,
  }
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as TypedConfigService
}

class ScopedHandler {
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.READINESS)
  readiness() {}

  undecorated() {}
}

function executionContext(handler: () => void, authorization?: string): { context: ExecutionContext; request: any } {
  const request = {
    method: 'GET',
    originalUrl: '/api/internal/backoffice/v1/readiness',
    headers: { authorization },
  }
  return {
    request,
    context: {
      getHandler: () => handler,
      getClass: () => ScopedHandler,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  }
}

describe('Backoffice workload authentication', () => {
  it.each([CURRENT_TOKEN, NEXT_TOKEN])('accepts a configured rotation slot', (token) => {
    const authenticator = new BackofficeWorkloadAuthenticator(config())

    expect(authenticator.authenticate(`Bearer ${token}`)).toEqual({
      role: 'backoffice-workload',
      credential: 'read',
      routeScopes: Object.values(BackofficeWorkloadRouteScope),
    })
  })

  it.each([
    undefined,
    '',
    'Basic synthetic-current-workload-token',
    'Bearer',
    'Bearer ',
    'Bearer wrong-workload-token',
    'Bearer token with spaces',
  ])('rejects missing, malformed, or invalid authorization without reflecting it', (authorization) => {
    const authenticator = new BackofficeWorkloadAuthenticator(config())

    try {
      authenticator.authenticate(authorization)
      throw new Error('expected authentication to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException)
      if (authorization) {
        expect(String(error)).not.toContain(authorization)
      }
    }
  })

  it('hides the route while the feature is disabled', () => {
    const guard = new BackofficeWorkloadAuthGuard(new BackofficeWorkloadAuthenticator(config(false)), new Reflector())
    const { context } = executionContext(ScopedHandler.prototype.readiness, `Bearer ${CURRENT_TOKEN}`)

    expect(() => guard.canActivate(context)).toThrow(NotFoundException)
  })

  it('fails closed when a guarded handler has no declared route scope', () => {
    const guard = new BackofficeWorkloadAuthGuard(new BackofficeWorkloadAuthenticator(config()), new Reflector())
    const { context } = executionContext(ScopedHandler.prototype.undecorated, `Bearer ${CURRENT_TOKEN}`)

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })

  it('attaches the validated workload principal for the declared route scope', () => {
    const guard = new BackofficeWorkloadAuthGuard(new BackofficeWorkloadAuthenticator(config()), new Reflector())
    const { context, request } = executionContext(ScopedHandler.prototype.readiness, `Bearer ${CURRENT_TOKEN}`)

    expect(guard.canActivate(context)).toBe(true)
    expect(request.user).toEqual({
      role: 'backoffice-workload',
      credential: 'read',
      routeScopes: Object.values(BackofficeWorkloadRouteScope),
    })
  })

  it('rejects a valid principal that lacks the route scope', () => {
    const authenticator = {
      isEnabled: () => true,
      authenticate: () => ({ role: 'backoffice-workload', credential: 'read', routeScopes: [] }),
    }
    const guard = new BackofficeWorkloadAuthGuard(authenticator as any, new Reflector())
    const { context } = executionContext(ScopedHandler.prototype.readiness, `Bearer ${CURRENT_TOKEN}`)

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })

  it('rejects a scope annotation applied to a different method or path', () => {
    const guard = new BackofficeWorkloadAuthGuard(new BackofficeWorkloadAuthenticator(config()), new Reflector())
    const { context, request } = executionContext(ScopedHandler.prototype.readiness, `Bearer ${CURRENT_TOKEN}`)
    request.originalUrl = '/api/internal/backoffice/v1/boxes'

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })

  it.each([
    [BackofficeWorkloadRouteScope.BOXES, '/api/internal/backoffice/v1/boxes'],
    [BackofficeWorkloadRouteScope.BOX, '/api/internal/backoffice/v1/boxes/AbCdEf123456'],
    [BackofficeWorkloadRouteScope.RUNNERS, '/api/internal/backoffice/v1/runners'],
    [BackofficeWorkloadRouteScope.RUNNER, '/api/internal/backoffice/v1/runners/22222222-2222-4222-8222-222222222222'],
  ])('matches the protected inventory scope %s without widening it', (scope, originalUrl) => {
    class InventoryHandler {
      @RequireBackofficeWorkloadRoute(scope)
      read() {}
    }
    const guard = new BackofficeWorkloadAuthGuard(new BackofficeWorkloadAuthenticator(config()), new Reflector())
    const { context, request } = executionContext(InventoryHandler.prototype.read, `Bearer ${CURRENT_TOKEN}`)
    request.originalUrl = originalUrl

    expect(guard.canActivate(context)).toBe(true)
    request.originalUrl = `${originalUrl}/unexpected`
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })
})
