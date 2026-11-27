/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { Singleflight } from '../../common/utils/singleflight.util'
import { Organization } from '../entities/organization.entity'
import { OrganizationUser } from '../entities/organization-user.entity'

const ORGANIZATION_CACHE_TTL_SECONDS = 60
const MEMBERSHIP_CACHE_TTL_SECONDS = 10
const logger = new Logger('OrganizationAccessCache')

const SET_IF_GENERATION = `
local current = redis.call('GET', KEYS[1]) or '0'
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`

const INVALIDATE = `
local generation = redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return generation
`

export type OrganizationMembershipReference = {
  organizationId: string
  userId: string
}

export function organizationMembershipCacheKey(organizationId: string, userId: string): string {
  return `organization-user:${organizationId}:${userId}`
}

function generationKey(cacheKey: string): string {
  return `organization-access:generation:${cacheKey}`
}

async function invalidate(redis: Redis, cacheKey: string): Promise<void> {
  try {
    await redis.eval(INVALIDATE, 2, generationKey(cacheKey), cacheKey)
  } catch (error) {
    logger.error(`Failed to invalidate organization access cache ${cacheKey}:`, error)
  }
}

export async function invalidateOrganizationAccessCache(redis: Redis, organizationId: string): Promise<void> {
  await invalidate(redis, `organization:${organizationId}`)
}

export async function invalidateMembershipAccessCache(
  redis: Redis,
  organizationId: string,
  userId: string,
): Promise<void> {
  await invalidate(redis, organizationMembershipCacheKey(organizationId, userId))
}

export async function invalidateMembershipAccessCaches(
  redis: Redis,
  memberships: OrganizationMembershipReference[],
): Promise<void> {
  const unique = new Map(
    memberships.map((membership) => [
      `${membership.organizationId}:${membership.userId}`,
      membership,
    ]),
  )
  await Promise.all(
    [...unique.values()].map((membership) =>
      invalidateMembershipAccessCache(redis, membership.organizationId, membership.userId),
    ),
  )
}

export class OrganizationAccessCache {
  private readonly singleflight = new Singleflight()

  constructor(private readonly redis: Redis) {}

  async getOrganization(
    organizationId: string,
    loader: () => Promise<Organization | null>,
  ): Promise<Organization | null> {
    return this.read(`organization:${organizationId}`, ORGANIZATION_CACHE_TTL_SECONDS, loader, (raw) => {
      const organization = Object.assign(Object.create(Organization.prototype), JSON.parse(raw)) as Organization
      for (const field of ['createdAt', 'updatedAt', 'suspendedAt', 'suspendedUntil'] as const) {
        const value = organization[field]
        if (value != null) (organization as any)[field] = new Date(value)
      }
      return organization
    })
  }

  async getOrganizationUser(
    organizationId: string,
    userId: string,
    loader: () => Promise<OrganizationUser | null>,
  ): Promise<OrganizationUser | null> {
    return this.read(
      organizationMembershipCacheKey(organizationId, userId),
      MEMBERSHIP_CACHE_TTL_SECONDS,
      loader,
      (raw) => JSON.parse(raw) as OrganizationUser,
    )
  }

  async invalidateOrganization(organizationId: string): Promise<void> {
    await invalidateOrganizationAccessCache(this.redis, organizationId)
  }

  private async read<T>(
    cacheKey: string,
    ttlSeconds: number,
    loader: () => Promise<T | null>,
    parse: (raw: string) => T,
  ): Promise<T | null> {
    const cached = await this.redis.get(cacheKey)
    if (cached !== null) return parse(cached)

    const generation = (await this.redis.get(generationKey(cacheKey))) ?? '0'
    const serialized = await this.singleflight.run<string | null>(`${cacheKey}:generation:${generation}`, async () => {
      const value = await loader()
      if (!value) return null
      const raw = JSON.stringify(value)
      await this.redis.eval(
        SET_IF_GENERATION,
        2,
        generationKey(cacheKey),
        cacheKey,
        generation,
        raw,
        ttlSeconds,
      )
      return raw
    })
    return serialized === null ? null : parse(serialized)
  }
}
