/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type ExecutionContext } from '@nestjs/common'
import { METHOD_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

// http-proxy-middleware ships ESM only and the proxy controller imports it at
// module scope; mock it the way the routing spec does so the class can load.
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))

const { WRITE_BOXES, DELETE_BOXES } = OrganizationResourcePermission
const reflector = new Reflector()

// GHSA-2qqv-7cwv-mj8h / POL-845: every mutating REST box and proxy route must
// carry the box permission the resource guard enforces. A route with no
// `RequiredOrganizationResourcePermissions` metadata falls through the guard and
// is reachable by any authenticated key — including one with `permissions: []`.
//
// `null` means intentionally open: a read a plain org member may perform. There
// is no `read:boxes` permission, so reads are gated by membership alone.
const EXPECTED: Record<string, OrganizationResourcePermission[] | null> = {
  // box controller
  createBox: [WRITE_BOXES],
  listBoxes: null,
  getBox: null,
  headBox: null,
  removeBox: [DELETE_BOXES],
  startBox: [WRITE_BOXES],
  stopBox: [WRITE_BOXES],
  updateInboundNetwork: [WRITE_BOXES],
  updateOutboundNetwork: [WRITE_BOXES],
  // proxy controller
  proxyExec: [WRITE_BOXES],
  proxyExecSignal: [WRITE_BOXES],
  proxyExecResize: [WRITE_BOXES],
  proxyExecKill: [WRITE_BOXES],
  proxyFiles: [WRITE_BOXES],
  proxyNetworkTunnel: [WRITE_BOXES],
  revokeNetworkTunnel: [WRITE_BOXES],
  configureSsh: [WRITE_BOXES],
  disableSsh: [WRITE_BOXES],
  proxyExecStatus: null,
  proxyExecList: null,
  proxyMetrics: null,
  getSshStatus: null,
}

type Controller = { new (...args: never[]): unknown; name: string }

/** Route handlers on a controller, found the way Nest finds them. */
function routeMethods(controller: Controller): string[] {
  const prototype = controller.prototype
  return Object.getOwnPropertyNames(prototype)
    .filter((method) => method !== 'constructor')
    .filter((method) => Reflect.getMetadata(METHOD_METADATA, prototype[method]) !== undefined)
}

describe('REST box/proxy permission coverage (GHSA-2qqv-7cwv-mj8h)', () => {
  const controllers: Controller[] = [BoxliteBoxController as Controller, BoxliteProxyController as Controller]
  const handlers = controllers.flatMap((controller) =>
    routeMethods(controller).map((method) => [`${controller.name}.${method}`, controller, method] as const),
  )

  it('has an expectation for every route handler, so no new route escapes the audit', () => {
    const audited = Object.keys(EXPECTED).sort()
    const actual = handlers.map(([, , method]) => method).sort()
    expect(actual).toEqual(audited)
  })

  it.each(handlers)('enforces the expected box permission on %s', (_name, controller, method) => {
    const got = reflector.get(RequiredOrganizationResourcePermissions, controller.prototype[method]) ?? null
    expect(got).toEqual(EXPECTED[method])
  })
})

describe('execution inventory authorization', () => {
  const memberKey = {
    userId: 'member',
    role: 'user',
    organizationId: 'org-1',
    apiKey: { organizationId: 'org-1', permissions: [] },
  }

  function inventoryGuard(member: boolean) {
    const guard = new OrganizationResourceActionGuard(
      { findOne: async (id: string) => ({ id }) } as never,
      {
        findOne: async (organizationId: string, userId: string) =>
          member ? { organizationId, userId, role: 'member' } : null,
      } as never,
      reflector,
    )
    Object.assign(guard, { redis: { get: async () => null, set: async () => 'OK' } })
    return guard
  }

  function inventoryContext(user: unknown, prefix?: string): ExecutionContext {
    const request = { user, params: { prefix } }
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => BoxliteProxyController.prototype.proxyExecList,
      getClass: () => BoxliteProxyController,
    } as unknown as ExecutionContext
  }

  it('allows an organization member with no box write permission to discover executions', async () => {
    await expect(inventoryGuard(true).canActivate(inventoryContext(memberKey))).resolves.toBe(true)
  })

  it('refuses a key whose user no longer belongs to the organization', async () => {
    await expect(inventoryGuard(false).canActivate(inventoryContext(memberKey))).resolves.toBe(false)
  })

  it('does not let an organization key select a different organization', async () => {
    await expect(inventoryGuard(true).canActivate(inventoryContext(memberKey, 'org-2'))).resolves.toBe(false)
  })

  it('does not expose inventory to a machine credential without organization membership', async () => {
    await expect(inventoryGuard(true).canActivate(inventoryContext({ role: 'runner' }))).resolves.toBe(false)
  })
})
