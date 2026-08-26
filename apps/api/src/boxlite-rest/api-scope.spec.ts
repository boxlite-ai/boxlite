/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { METHOD_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { API_SCOPES, ApiScope, RestApiScope, SCOPE_REQUIREMENTS, resolveApiScopes } from './api-scope'
import { BoxliteApiKeyController } from './boxlite-api-key.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteRestModule } from './boxlite-rest.module'
import { BoxliteVolumeController } from './boxlite-volume.controller'

// http-proxy-middleware ships ESM only and the proxy controller imports it at
// module scope; the routing spec stubs it the same way.
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))

const reflector = new Reflector()

// `/v1/config` is capability discovery served before any credential exists, so
// it carries no scope and is excluded from the coverage assertion below.
const UNSCOPED_CONTROLLERS = [BoxliteConfigController]

const SCOPED_CONTROLLERS = [
  BoxliteMeController,
  BoxliteBoxController,
  BoxliteVolumeController,
  BoxliteApiKeyController,
  BoxliteProxyController,
]

type Handler = { controller: string; method: string; fn: (...args: unknown[]) => unknown }

/** Every route handler on a controller, found the way Nest finds them. */
function routeHandlers(controller: (new (...args: never[]) => unknown) & { name: string }): Handler[] {
  const prototype = controller.prototype
  return Object.getOwnPropertyNames(prototype)
    .filter((method) => method !== 'constructor')
    .map((method) => ({ controller: controller.name, method, fn: prototype[method] }))
    .filter((handler) => Reflect.getMetadata(METHOD_METADATA, handler.fn) !== undefined)
}

const scopedHandlers = SCOPED_CONTROLLERS.flatMap(routeHandlers)

describe('REST scope coverage', () => {
  it('audits every controller the REST module registers', () => {
    const registered = (Reflect.getMetadata('controllers', BoxliteRestModule) as Array<{ name: string }>).map(
      (controller) => controller.name,
    )

    expect(registered.sort()).toEqual([...SCOPED_CONTROLLERS, ...UNSCOPED_CONTROLLERS].map((c) => c.name).sort())
  })

  it('finds route handlers to audit', () => {
    expect(scopedHandlers.length).toBeGreaterThan(0)
  })

  it.each(scopedHandlers.map((handler) => [`${handler.controller}.${handler.method}`, handler] as const))(
    'declares a scope for %s',
    (_name, handler) => {
      expect(API_SCOPES).toContain(reflector.get(RestApiScope, handler.fn))
    },
  )
})

describe('SCOPE_REQUIREMENTS tracks what the guards enforce', () => {
  // A scope is only honest if holding its listed permissions is enough for
  // every route it covers — and if nothing less would do.
  const enforcedByScope = new Map<ApiScope, Set<OrganizationResourcePermission>>()
  for (const handler of scopedHandlers) {
    const scope = reflector.get(RestApiScope, handler.fn)
    const required: OrganizationResourcePermission[] =
      reflector.get(RequiredOrganizationResourcePermissions, handler.fn) ?? []
    const seen = enforcedByScope.get(scope) ?? new Set()
    required.forEach((permission) => seen.add(permission))
    enforcedByScope.set(scope, seen)
  }

  it.each([...enforcedByScope.entries()])('matches the routes behind %s', (scope, enforced) => {
    expect([...SCOPE_REQUIREMENTS[scope]].sort()).toEqual([...enforced].sort())
  })

  it('has no scope in the vocabulary that no route serves', () => {
    expect(API_SCOPES.filter((scope) => !enforcedByScope.has(scope))).toEqual([])
  })
})

describe('resolveApiScopes', () => {
  const VOLUME_LIFECYCLE = [
    OrganizationResourcePermission.READ_VOLUMES,
    OrganizationResourcePermission.WRITE_VOLUMES,
    OrganizationResourcePermission.DELETE_VOLUMES,
  ]

  it('reports every scope for a caller the guard does not bound', () => {
    expect(resolveApiScopes(null)).toEqual([...API_SCOPES])
  })

  it('withholds a volume scope the caller cannot exercise', () => {
    const boxesOnly = resolveApiScopes([
      OrganizationResourcePermission.WRITE_BOXES,
      OrganizationResourcePermission.DELETE_BOXES,
    ])

    expect(boxesOnly).not.toContain('volume:read')
    expect(boxesOnly).not.toContain('volume:write')
    expect(boxesOnly).not.toContain('volume:delete')
  })

  it('reports the volume scopes a volume key can exercise', () => {
    expect(resolveApiScopes(VOLUME_LIFECYCLE)).toEqual(
      expect.arrayContaining(['volume:read', 'volume:write', 'volume:delete']),
    )
  })

  it('grants each volume scope independently of the others', () => {
    const readOnly = resolveApiScopes([OrganizationResourcePermission.READ_VOLUMES])

    expect(readOnly).toContain('volume:read')
    expect(readOnly).not.toContain('volume:write')
  })

  it('never claims a resource this deployment serves no route for', () => {
    expect(
      resolveApiScopes(null).filter((scope) => scope.startsWith('image:') || scope.startsWith('snapshot:')),
    ).toEqual([])
  })
})
