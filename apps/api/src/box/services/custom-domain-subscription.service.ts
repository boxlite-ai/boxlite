/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { HttpException, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { Redis } from 'ioredis'
import { TypedConfigService } from '../../config/typed-config.service'

export type DomainSubscription = 'active' | 'required' | 'unavailable'
export type DomainSubscriptionGrant = { status: DomainSubscription; expiresAt: number }

const CACHE_TTL_MS = 60_000
const RETRY_TTL_MS = 30_000
const CACHE_PREFIX = 'commerce:custom-domain-subscription:v2:'

// Compare and publish together: a timed-out refresher cannot overwrite a newer
// result. Redis time also bounds lifetime when the API clock runs ahead.
const PUBLISH_GRANT = `
  if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local grant = cjson.decode(ARGV[2])
  grant.expiresAt = math.min(grant.expiresAt, now + tonumber(ARGV[3]))
  redis.call('SET', KEYS[1], cjson.encode(grant))
  redis.call('PEXPIREAT', KEYS[1], grant.expiresAt)
  return 1
`
const RELEASE_REFRESH = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`

/** Interprets Commerce's effective entitlement, independently of numeric Box limits. */
export function subscriptionExpiry(data: unknown, now: number): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid subscription response')
  if (Object.keys(data).length === 0) return null
  const plan = (data as { plan?: unknown }).plan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Invalid subscription plan')
  const { status, entitlements, cycleTo } = plan as Record<string, unknown>
  if (entitlements !== undefined && entitlements !== 'active' && entitlements !== 'suspended') {
    throw new Error('Invalid subscription entitlements')
  }
  if (status !== 'active' && status !== 'past_due' && status !== 'canceled') {
    throw new Error('Invalid subscription status')
  }
  if (status === 'canceled' || entitlements === 'suspended' || (status === 'past_due' && entitlements !== 'active')) {
    return null
  }
  const end = typeof cycleTo === 'string' ? Date.parse(cycleTo) : NaN
  if (!Number.isFinite(end)) throw new Error('Invalid subscription cycle')
  return end > now ? Math.min(end, now + CACHE_TTL_MS) : null
}

export function requireDomainSubscription(status: DomainSubscription): void {
  if (status === 'active') return
  throw new HttpException(
    status === 'required'
      ? {
          code: 'subscription_required',
          message: 'An active organization subscription is required for custom domains.',
        }
      : { code: 'subscription_not_ready', message: 'Subscription eligibility is unavailable. Refresh in Dashboard.' },
    status === 'required' ? 403 : 409,
  )
}

@Injectable()
export class CustomDomainSubscriptionService {
  private readonly logger = new Logger(CustomDomainSubscriptionService.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly config: TypedConfigService,
  ) {}

  /** Cache-only lookup for bind errors; never calls Commerce or renews expiry. */
  async read(organizationId: string): Promise<DomainSubscriptionGrant> {
    try {
      const raw = await this.withCacheTimeout(this.redis.get(this.cacheKey(organizationId)))
      if (raw !== null) {
        const grant = JSON.parse(raw) as DomainSubscriptionGrant
        if (
          grant &&
          ['active', 'required', 'unavailable'].includes(grant.status) &&
          Number.isSafeInteger(grant.expiresAt) &&
          grant.expiresAt > Date.now()
        )
          return { status: grant.status, expiresAt: grant.expiresAt }
      }
    } catch {
      this.logger.warn(`Unable to read custom-domain subscription cache for organization ${organizationId}`)
    }
    return { status: 'unavailable', expiresAt: 0 }
  }

  /** Coalesce across API replicas; a lost or expired refresh lease cannot publish a result. */
  async refresh(organizationId: string): Promise<DomainSubscriptionGrant> {
    const cached = await this.read(organizationId)
    if (cached.expiresAt > Date.now()) return cached
    const key = this.cacheKey(organizationId)
    const lock = `${key}:refresh`
    const owner = randomUUID()
    try {
      if (!(await this.withCacheTimeout(this.redis.set(lock, owner, 'PX', 10_000, 'NX')))) {
        return this.read(organizationId)
      }
      const completed = await this.read(organizationId)
      if (completed.expiresAt > Date.now()) return completed
      let grant: DomainSubscriptionGrant
      try {
        const base = this.config.get('billingApiUrl')?.trim()
        const token = this.config.get('usageExport.token')?.trim()
        if (!base || !token) throw new Error('Commerce is unavailable')
        const url = new URL(base)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('Invalid Commerce endpoint')
        }
        const { data } = await axios.get<unknown>(
          `${base.replace(/\/+$/, '')}/organization/${encodeURIComponent(organizationId)}/plan`,
          { timeout: 2_000, maxRedirects: 0, headers: { authorization: `Bearer ${token}` } },
        )
        const expiresAt = subscriptionExpiry(data, Date.now())
        grant =
          expiresAt === null
            ? { status: 'required', expiresAt: Date.now() + RETRY_TTL_MS }
            : { status: 'active', expiresAt }
      } catch {
        this.logger.warn(`Unable to check custom-domain subscription for organization ${organizationId}`)
        grant = { status: 'unavailable', expiresAt: Date.now() + RETRY_TTL_MS }
      }
      await this.withCacheTimeout(
        this.redis.eval(
          PUBLISH_GRANT,
          2,
          key,
          lock,
          owner,
          JSON.stringify(grant),
          grant.status === 'active' ? CACHE_TTL_MS : RETRY_TTL_MS,
        ),
      )
    } catch {
      this.logger.warn(`Unable to refresh custom-domain subscription cache for organization ${organizationId}`)
    } finally {
      await this.withCacheTimeout(this.redis.eval(RELEASE_REFRESH, 1, lock, owner)).catch(() => {
        this.logger.warn(`Unable to release custom-domain subscription refresh for organization ${organizationId}`)
      })
    }
    return this.read(organizationId)
  }

  private cacheKey(organizationId: string): string {
    return `${CACHE_PREFIX}{${encodeURIComponent(organizationId)}}`
  }

  private async withCacheTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Subscription cache timed out')), 1_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
