/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Request } from 'express'
import { OrganizationResourcePermission as P } from '../organization/enums/organization-resource-permission.enum'

/**
 * The permissions an MCP OAuth token can carry: workload resources only. Members,
 * registries, regions, runners and audit logs stay with API keys, so no OAuth
 * grant can manage credentials or who belongs to the organization.
 */
export const MCP_OAUTH_SCOPES: readonly string[] = [
  P.WRITE_BOXES,
  P.DELETE_BOXES,
  P.READ_VOLUMES,
  P.WRITE_VOLUMES,
  P.DELETE_VOLUMES,
  P.READ_IMAGES,
  P.WRITE_IMAGES,
  P.DELETE_IMAGES,
  P.WRITE_TEMPLATES,
  P.DELETE_TEMPLATES,
]

/**
 * The scopes a client asks for at sign-in, advertised by the 401 challenge and
 * `scopes_supported` (MCP scope minimization): enough for the direct box tools.
 * Every other scope comes later through an `insufficient_scope` step-up.
 */
export const MCP_OAUTH_BASELINE_SCOPES: readonly string[] = [P.WRITE_BOXES]

/**
 * The catalog operations an OAuth caller may run; every other operation answers
 * 403 and needs an API key. Default deny: an operation added to the API stays
 * API-key only until it is listed here. Left out on purpose: SSH keys, tunnels,
 * inbound and outbound network rules, domains, export and import, registries,
 * members and invitations, since each grants access that outlives the token.
 */
export const MCP_OAUTH_OPERATIONS: ReadonlySet<string> = new Set([
  'getConfig',
  'getCurrentPrincipal',
  'createVolume',
  'listVolumes',
  'getVolume',
  'removeVolume',
  'createBox',
  'listBoxes',
  'getBox',
  'boxExists',
  'removeBox',
  'startBox',
  'stopBox',
  'getSshStatus',
  'disableSsh',
  'createSnapshot',
  'listSnapshots',
  'getSnapshot',
  'removeSnapshot',
  'restoreSnapshot',
  'cloneBox',
  'startExecution',
  'getExecution',
  'killExecution',
  'attachExecution',
  'signalExecution',
  'resizeExecution',
  'uploadFiles',
  'downloadFiles',
  'getRuntimeMetrics',
  'getBoxMetrics',
  'listImages',
  'getImageUsage',
  'getImage',
  'removeImage',
  'createImageAlias',
  'deleteImageAlias',
])

/** Request property `McpAuthGuard` sets for an OAuth caller: the MCP scopes its token grants. */
interface McpOAuthRequest extends Request {
  mcpOAuthScopes?: string[]
}

/** The scopes an OAuth caller's token grants, or `undefined` for an API-key caller. */
export function mcpOAuthScopes(request: Request): string[] | undefined {
  return (request as McpOAuthRequest).mcpOAuthScopes
}

export function setMcpOAuthScopes(request: Request, scopes: string[]): void {
  ;(request as McpOAuthRequest).mcpOAuthScopes = scopes
}

/** The MCP scopes a token's space-separated `scope` claim grants. */
export function grantedMcpScopes(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter((s) => MCP_OAUTH_SCOPES.includes(s)) : []
}
