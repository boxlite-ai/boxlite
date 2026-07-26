/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export const BOX_LOOKUP_CACHE_TTL_MS = 10_000
export const BOX_ORG_ID_CACHE_TTL_MS = 60_000
export const TOOLBOX_PROXY_URL_CACHE_TTL_S = 30 * 60 // 30 minutes
// The unbounded listBoxes endpoint materializes and serializes the org's whole
// box table per request; under poll-heavy traffic that pegs the single event
// loop. A short TTL collapses bursts of identical polls onto one query while
// keeping the list fresh within a few seconds.
export const BOX_LIST_CACHE_TTL_S = 3

export function boxListCacheKey(args: {
  organizationId: string
  labels?: { [key: string]: string }
  includeErroredDeleted?: boolean
}): string {
  const labels = args.labels
    ? JSON.stringify(Object.fromEntries(Object.entries(args.labels).sort(([a], [b]) => a.localeCompare(b))))
    : 'none'
  const includeErroredDeleted = args.includeErroredDeleted ? 1 : 0
  return `box:list:org:${args.organizationId}:errdel:${includeErroredDeleted}:labels:${labels}`
}

type BoxLookupCacheKeyArgs = {
  organizationId?: string | null
  returnDestroyed?: boolean
}

export function boxLookupCacheKeyById(args: BoxLookupCacheKeyArgs & { id: string }): string {
  const organizationId = args.organizationId ?? 'none'
  const returnDestroyed = args.returnDestroyed ? 1 : 0
  return `box:lookup:by-id:org:${organizationId}:returnDestroyed:${returnDestroyed}:value:${args.id}`
}

export function boxLookupCacheKeyByName(args: BoxLookupCacheKeyArgs & { boxName: string }): string {
  const organizationId = args.organizationId ?? 'none'
  const returnDestroyed = args.returnDestroyed ? 1 : 0
  return `box:lookup:by-name:org:${organizationId}:returnDestroyed:${returnDestroyed}:value:${args.boxName}`
}

export function boxLookupCacheKeyByAuthToken(args: { authToken: string }): string {
  return `box:lookup:by-authToken:${args.authToken}`
}

type BoxOrgIdCacheKeyArgs = {
  organizationId?: string
}

export function boxOrgIdCacheKeyById(args: BoxOrgIdCacheKeyArgs & { id: string }): string {
  const organizationId = args.organizationId ?? 'none'
  return `box:orgId:by-id:org:${organizationId}:value:${args.id}`
}

export function boxOrgIdCacheKeyByName(args: BoxOrgIdCacheKeyArgs & { boxName: string }): string {
  const organizationId = args.organizationId ?? 'none'
  return `box:orgId:by-name:org:${organizationId}:value:${args.boxName}`
}

export function toolboxProxyUrlCacheKey(regionId: string): string {
  return `toolbox-proxy-url:region:${regionId}`
}
