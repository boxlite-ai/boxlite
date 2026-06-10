/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export const BOX_LOOKUP_CACHE_TTL_MS = 10_000
export const BOX_ORG_ID_CACHE_TTL_MS = 60_000
export const TOOLBOX_PROXY_URL_CACHE_TTL_S = 30 * 60 // 30 minutes

type BoxLookupCacheKeyArgs = {
  organizationId?: string | null
  returnDestroyed?: boolean
}

export function boxLookupCacheKeyById(args: BoxLookupCacheKeyArgs & { boxId: string }): string {
  const organizationId = args.organizationId ?? 'none'
  const returnDestroyed = args.returnDestroyed ? 1 : 0
  return `box:lookup:by-id:org:${organizationId}:returnDestroyed:${returnDestroyed}:value:${args.boxId}`
}

export function boxLookupCacheKeyByBoxId(args: BoxLookupCacheKeyArgs & { boxId: string }): string {
  const organizationId = args.organizationId ?? 'none'
  const returnDestroyed = args.returnDestroyed ? 1 : 0
  return `box:lookup:by-box-id:org:${organizationId}:returnDestroyed:${returnDestroyed}:value:${args.boxId}`
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

export function boxOrgIdCacheKeyById(args: BoxOrgIdCacheKeyArgs & { boxId: string }): string {
  const organizationId = args.organizationId ?? 'none'
  return `box:orgId:by-id:org:${organizationId}:value:${args.boxId}`
}

export function boxOrgIdCacheKeyByBoxId(args: BoxOrgIdCacheKeyArgs & { boxId: string }): string {
  const organizationId = args.organizationId ?? 'none'
  return `box:orgId:by-box-id:org:${organizationId}:value:${args.boxId}`
}

export function boxOrgIdCacheKeyByName(args: BoxOrgIdCacheKeyArgs & { boxName: string }): string {
  const organizationId = args.organizationId ?? 'none'
  return `box:orgId:by-name:org:${organizationId}:value:${args.boxName}`
}

export function toolboxProxyUrlCacheKey(regionId: string): string {
  return `toolbox-proxy-url:region:${regionId}`
}
