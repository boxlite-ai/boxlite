/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { DataSource } from 'typeorm'
import {
  boxLookupCacheKeyByAuthToken,
  boxLookupCacheKeyByBoxId,
  boxLookupCacheKeyById,
  boxLookupCacheKeyByName,
  boxOrgIdCacheKeyByBoxId,
  boxOrgIdCacheKeyById,
  boxOrgIdCacheKeyByName,
} from '../utils/box-lookup-cache.util'

type InvalidateBoxLookupCacheArgs =
  | {
      id: string
      boxId: string
      organizationId: string
      name: string
      previousOrganizationId?: string | null
      previousBoxId?: string | null
      previousName?: string | null
    }
  | {
      authToken: string
    }

@Injectable()
export class BoxLookupCacheInvalidationService {
  private readonly logger = new Logger(BoxLookupCacheInvalidationService.name)

  constructor(private readonly dataSource: DataSource) {}

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
    const boxIds = Array.from(
      new Set([args.boxId, args.previousBoxId].filter((id): id is string => Boolean(id && id.trim().length > 0))),
    )

    const cacheIds: string[] = []
    for (const organizationId of organizationIds) {
      for (const returnDestroyed of [false, true]) {
        cacheIds.push(
          boxLookupCacheKeyById({
            organizationId,
            returnDestroyed,
            boxId: args.id,
          }),
        )
        for (const boxId of boxIds) {
          cacheIds.push(
            boxLookupCacheKeyByBoxId({
              organizationId,
              returnDestroyed,
              boxId,
            }),
          )
        }
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
      .then(() => this.logger.debug(`Invalidated box lookup cache for ${args.boxId}`))
      .catch((error) =>
        this.logger.warn(
          `Failed to invalidate box lookup cache for ${args.boxId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }

  invalidateOrgId(args: {
    id: string
    boxId: string
    organizationId: string
    name: string
    previousOrganizationId?: string | null
    previousBoxId?: string | null
    previousName?: string | null
  }): void {
    const cache = this.dataSource.queryResultCache
    if (!cache) {
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
    const boxIds = Array.from(
      new Set([args.boxId, args.previousBoxId].filter((id): id is string => Boolean(id && id.trim().length > 0))),
    )

    const cacheIds: string[] = []
    for (const organizationId of organizationIds) {
      cacheIds.push(
        boxOrgIdCacheKeyById({
          organizationId,
          boxId: args.id,
        }),
      )
      for (const boxId of boxIds) {
        cacheIds.push(
          boxOrgIdCacheKeyByBoxId({
            organizationId,
            boxId,
          }),
        )
      }
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
    cacheIds.push(boxOrgIdCacheKeyById({ boxId: args.id }))
    for (const boxId of boxIds) {
      cacheIds.push(boxOrgIdCacheKeyByBoxId({ boxId }))
    }
    for (const boxName of names) {
      cacheIds.push(boxOrgIdCacheKeyByName({ boxName }))
    }

    cache
      .remove(cacheIds)
      .then(() => this.logger.debug(`Invalidated box orgId cache for ${args.boxId}`))
      .catch((error) =>
        this.logger.warn(
          `Failed to invalidate box orgId cache for ${args.boxId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }
}
