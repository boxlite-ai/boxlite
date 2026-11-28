/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { TtlLruCache } from '../../common/utils/ttl-lru-cache.util'
import { Singleflight } from '../../common/utils/singleflight.util'
import {
  boxLookupCacheKeyByAuthToken,
  BOX_ORG_ID_CACHE_TTL_MS,
  boxLookupCacheKeyById,
  boxLookupCacheKeyByName,
  boxOrgIdCacheKeyById,
  boxOrgIdCacheKeyByName,
} from '../utils/box-lookup-cache.util'

type InvalidateBoxLookupCacheArgs =
  | {
      id: string
      organizationId: string
      name: string
      previousOrganizationId?: string | null
      previousName?: string | null
    }
  | {
      authToken: string
    }

@Injectable()
export class BoxLookupCacheInvalidationService {
  private readonly logger = new Logger(BoxLookupCacheInvalidationService.name)
  private readonly organizationIdCache = new TtlLruCache<string, string>(10_000, BOX_ORG_ID_CACHE_TTL_MS)
  private readonly organizationIdSingleflight = new Singleflight()

  constructor(private readonly dataSource: DataSource) {}

  async getOrganizationId(cacheKey: string, loader: () => Promise<string | null>): Promise<string | null> {
    const cached = this.getCachedOrganizationId(cacheKey)
    if (cached !== undefined) return cached

    return this.organizationIdSingleflight.run(cacheKey, async () => {
      const organizationId = await loader()
      if (organizationId) this.organizationIdCache.set(cacheKey, organizationId)
      return organizationId
    })
  }

  getCachedOrganizationId(cacheKey: string): string | undefined {
    return this.organizationIdCache.get(cacheKey)
  }

  invalidate(args: InvalidateBoxLookupCacheArgs): void {
    const cache = this.dataSource.queryResultCache
    if (!cache) {
      return
    }

    if ('authToken' in args) {
      cache
        .remove([boxLookupCacheKeyByAuthToken({ authToken: args.authToken })])
        .then(() => this.logger.debug(`Invalidated box lookup cache for authToken ${args.authToken}`))
        .catch((error) =>
          this.logger.warn(
            `Failed to invalidate box lookup cache for authToken ${args.authToken}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      return
    }

    const organizationIds = Array.from(
      new Set(
        [args.organizationId, args.previousOrganizationId].filter((id): id is string =>
          Boolean(id && id.trim().length > 0),
        ),
      ),
    )
    const names = Array.from(
      new Set([args.name, args.previousName].filter((n): n is string => Boolean(n && n.trim().length > 0))),
    )

    const cacheIds: string[] = []
    for (const organizationId of organizationIds) {
      for (const returnDestroyed of [false, true]) {
        cacheIds.push(
          boxLookupCacheKeyById({
            organizationId,
            returnDestroyed,
            id: args.id,
          }),
        )
        for (const boxName of names) {
          cacheIds.push(
            boxLookupCacheKeyByName({
              organizationId,
              returnDestroyed,
              boxName,
            }),
          )
        }
      }
    }

    if (cacheIds.length === 0) {
      return
    }

    cache
      .remove(cacheIds)
      .then(() => this.logger.debug(`Invalidated box lookup cache for ${args.id}`))
      .catch((error) =>
        this.logger.warn(
          `Failed to invalidate box lookup cache for ${args.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }

  invalidateOrgId(args: {
    id: string
    organizationId: string
    name: string
    previousOrganizationId?: string | null
    previousName?: string | null
  }): void {
    const organizationIds = Array.from(
      new Set(
        [args.organizationId, args.previousOrganizationId].filter((id): id is string =>
          Boolean(id && id.trim().length > 0),
        ),
      ),
    )
    const names = Array.from(
      new Set([args.name, args.previousName].filter((n): n is string => Boolean(n && n.trim().length > 0))),
    )

    const cacheIds: string[] = []
    for (const organizationId of organizationIds) {
      cacheIds.push(
        boxOrgIdCacheKeyById({
          organizationId,
          id: args.id,
        }),
      )
      for (const boxName of names) {
        cacheIds.push(
          boxOrgIdCacheKeyByName({
            organizationId,
            boxName,
          }),
        )
      }
    }

    // Also invalidate the "no org" variants (when organizationId was not provided to getOrganizationId)
    cacheIds.push(boxOrgIdCacheKeyById({ id: args.id }))
    for (const boxName of names) {
      cacheIds.push(boxOrgIdCacheKeyByName({ boxName }))
    }

    for (const cacheId of cacheIds) this.organizationIdCache.delete(cacheId)

    const cache = this.dataSource.queryResultCache
    if (!cache) return

    cache
      .remove(cacheIds)
      .then(() => this.logger.debug(`Invalidated box orgId cache for ${args.id}`))
      .catch((error) =>
        this.logger.warn(
          `Failed to invalidate box orgId cache for ${args.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }
}
