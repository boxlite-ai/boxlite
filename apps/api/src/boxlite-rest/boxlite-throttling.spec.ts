/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { GUARDS_METADATA } from '@nestjs/common/constants'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { THROTTLER_SCOPE_KEY } from '../common/decorators/throttler-scope.decorator'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function guardsFor(controller: object): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
}

describe('BoxLite v1 throttling metadata', () => {
  it('applies the anonymous limiter to public v1 discovery', () => {
    expect(guardsFor(BoxliteConfigController)).toEqual(expect.arrayContaining([AnonymousRateLimitGuard]))
  })

  it('applies the authenticated limiter after authentication and organization access', () => {
    expect(guardsFor(BoxliteMeController)).toEqual([CombinedAuthGuard, AuthenticatedRateLimitGuard])
    expect(guardsFor(BoxliteBoxController)).toEqual([
      CombinedAuthGuard,
      OrganizationResourceActionGuard,
      AuthenticatedRateLimitGuard,
    ])
    expect(guardsFor(BoxliteProxyController)).toEqual([
      CombinedAuthGuard,
      OrganizationResourceActionGuard,
      AuthenticatedRateLimitGuard,
    ])
  })

  it('uses the existing box-create and lifecycle quota scopes for expensive mutations', () => {
    expect(Reflect.getMetadata(THROTTLER_SCOPE_KEY, BoxliteBoxController.prototype.createBox)).toEqual(['box-create'])
    expect(Reflect.getMetadata(THROTTLER_SCOPE_KEY, BoxliteBoxController.prototype.startBox)).toEqual(['box-lifecycle'])
    expect(Reflect.getMetadata(THROTTLER_SCOPE_KEY, BoxliteBoxController.prototype.stopBox)).toEqual(['box-lifecycle'])
    expect(Reflect.getMetadata(THROTTLER_SCOPE_KEY, BoxliteBoxController.prototype.removeBox)).toEqual([
      'box-lifecycle',
    ])
  })
})
