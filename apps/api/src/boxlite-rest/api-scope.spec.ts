/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { METHOD_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { ApiKey } from '../api-key/api-key.entity'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'
import { API_SCOPES, ApiScope, RestApiScope, SCOPE_REQUIREMENTS, apiScopesFor } from './api-scope'
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

const SCOPED_CONTROLLERS = [BoxliteMeController, BoxliteBoxController, BoxliteVolumeController, BoxliteProxyController]

type Controller = (new (...args: never[]) => unknown) & { name: string }
type Handler = { controller: string; cls: Controller; method: string; fn: (...args: unknown[]) => unknown }

/** Every route handler on a controller, found the way Nest finds them. */
function routeHandlers(controller: Controller): Handler[] {
  const prototype = controller.prototype
  return Object.getOwnPropertyNames(prototype)
    .filter((method) => method !== 'constructor')
    .map((method) => ({ controller: controller.name, cls: controller, method, fn: prototype[method] }))
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
    // The guard reads the handler first and falls back to the controller
    // class, so a class-level declaration binds every route on it.
    const required: OrganizationResourcePermission[] =
      reflector.get(RequiredOrganizationResourcePermissions, handler.fn) ??
      reflector.get(RequiredOrganizationResourcePermissions, handler.cls) ??
      []
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

describe('apiScopesFor', () => {
  const VOLUME_LIFECYCLE = [
    OrganizationResourcePermission.READ_VOLUMES,
    OrganizationResourcePermission.WRITE_VOLUMES,
    OrganizationResourcePermission.DELETE_VOLUMES,
  ]

  function context(overrides: Partial<OrganizationAuthContext>): OrganizationAuthContext {
    return {
      userId: 'user-1',
      email: 'dev@example.com',
      role: SystemRole.USER,
      organizationId: 'org-1',
      organization: { id: 'org-1' },
      ...overrides,
    } as OrganizationAuthContext
  }

  function keyContext(permissions: OrganizationResourcePermission[]): OrganizationAuthContext {
    return context({
      apiKey: { permissions } as ApiKey,
      // Every API key belongs to a member; owner here so the assertions cannot
      // pass by falling through to the membership rule.
      organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
    } as Partial<OrganizationAuthContext>)
  }

  it('reports every scope to a system admin', () => {
    expect(apiScopesFor(context({ role: SystemRole.ADMIN }))).toEqual([...API_SCOPES])
  })

  it('reports every scope to an interactive owner', () => {
    const owner = context({
      organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
    } as Partial<OrganizationAuthContext>)

    expect(apiScopesFor(owner)).toEqual([...API_SCOPES])
  })

  it("bounds an owner's API key by the permissions the key carries", () => {
    expect(apiScopesFor(keyContext(VOLUME_LIFECYCLE))).toEqual([...API_SCOPES])
    expect(apiScopesFor(keyContext([OrganizationResourcePermission.WRITE_BOXES]))).not.toContain('volume:read')
  })

  it('bounds an interactive member by the roles assigned to them', () => {
    const member = context({
      organizationUser: {
        role: OrganizationMemberRole.MEMBER,
        assignedRoles: [{ permissions: [OrganizationResourcePermission.READ_VOLUMES] }],
      },
    } as Partial<OrganizationAuthContext>)

    expect(apiScopesFor(member)).toContain('volume:read')
    expect(apiScopesFor(member)).not.toContain('volume:write')
  })

  // Known divergence, not an endorsement: OrganizationResourceActionGuard
  // refuses a caller carrying no organizationUser before it reads any
  // required-permission list, so every box scope below is reported and then
  // 403s. Only `me:read` is honest — `/v1/me` runs behind CombinedAuthGuard
  // alone. Closing it needs SCOPE_REQUIREMENTS to tell "requires no
  // permission" apart from "not behind the resource guard"; until then this
  // test exists so the gap is visible and a fix has to update it deliberately.
  it('over-reports box scopes to a caller with no membership, which the guard then refuses', () => {
    expect(apiScopesFor(context({}))).toEqual(['me:read', 'box:read', 'box:write', 'box:exec', 'box:delete'])
  })

  it('withholds every volume scope from a key that holds no volume permission', () => {
    const boxesOnly = apiScopesFor(
      keyContext([OrganizationResourcePermission.WRITE_BOXES, OrganizationResourcePermission.DELETE_BOXES]),
    )

    expect(boxesOnly).not.toContain('volume:read')
    expect(boxesOnly).not.toContain('volume:write')
    expect(boxesOnly).not.toContain('volume:delete')
  })

  it('grants each volume scope independently of the others', () => {
    const readOnly = apiScopesFor(keyContext([OrganizationResourcePermission.READ_VOLUMES]))

    expect(readOnly).toContain('volume:read')
    expect(readOnly).not.toContain('volume:write')
    expect(readOnly).not.toContain('volume:delete')
  })

  it('never claims a resource this deployment serves no route for', () => {
    const everything = apiScopesFor(context({ role: SystemRole.ADMIN }))

    expect(everything.filter((scope) => scope.startsWith('image:') || scope.startsWith('snapshot:'))).toEqual([])
    expect(everything.filter((scope) => scope.startsWith('api_key:'))).toEqual([])
  })
})
