/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { BoxliteRestModule } from './boxlite-rest.module'

// http-proxy-middleware ships ESM only and the proxy controller imports it at
// module scope; mock it the way the routing spec does so the class can load.
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))

const { WRITE_BOXES, DELETE_BOXES } = OrganizationResourcePermission
const reflector = new Reflector()

// GHSA-2qqv-7cwv-mj8h / POL-845: every mutating REST box, proxy and snapshot
// route must carry the box permission the resource guard enforces. A route with
// no `RequiredOrganizationResourcePermissions` metadata falls through the guard
// and is reachable by any authenticated key — including one with
// `permissions: []`.
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
  proxyExecStatus: null,
  proxyMetrics: null,
  // snapshot controllers
  createSnapshot: [WRITE_BOXES],
  createBoxFromSnapshot: [WRITE_BOXES],
  createBoxFromAnySnapshot: [WRITE_BOXES],
  listSnapshots: null,
  getSnapshot: null,
  removeSnapshot: [DELETE_BOXES],
  restoreSnapshot: [WRITE_BOXES],
  getSnapshotRestore: null,
  listAllSnapshots: null,
  getAnySnapshot: null,
  removeAnySnapshot: [DELETE_BOXES],
}

type Controller = { new (...args: never[]): unknown; name: string }

/** Route handlers on a controller, found the way Nest finds them: along its prototype chain. */
function routeMethods(controller: Controller): string[] {
  const methods = new Set<string>()
  for (
    let prototype = controller.prototype;
    prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    Object.getOwnPropertyNames(prototype)
      .filter((method) => method !== 'constructor')
      .filter((method) => Reflect.getMetadata(METHOD_METADATA, prototype[method]) !== undefined)
      .forEach((method) => methods.add(method))
  }
  return [...methods]
}

describe('REST box/proxy/snapshot permission coverage (GHSA-2qqv-7cwv-mj8h)', () => {
  // Every controller the REST module mounts under a box or snapshot path, so a
  // new one is audited without being listed here.
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BoxliteRestModule) as Controller[]).filter(
    (controller) =>
      [Reflect.getMetadata(PATH_METADATA, controller)].flat().some((path: string) => /boxes|snapshots/.test(path)),
  )
  const handlers = controllers.flatMap((controller) =>
    routeMethods(controller).map((method) => [`${controller.name}.${method}`, controller, method] as const),
  )

  it('has an expectation for every route handler, so no new route escapes the audit', () => {
    const audited = Object.keys(EXPECTED).sort()
    // Both organization snapshot mounts share their handlers.
    const actual = [...new Set(handlers.map(([, , method]) => method))].sort()
    expect(actual).toEqual(audited)
  })

  it.each(handlers)('enforces the expected box permission on %s', (_name, controller, method) => {
    const got = reflector.get(RequiredOrganizationResourcePermissions, controller.prototype[method]) ?? null
    expect(got).toEqual(EXPECTED[method])
  })
})
