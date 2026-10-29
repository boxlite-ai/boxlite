/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { Redis } from 'ioredis'
import { TypedConfigService } from '../../config/typed-config.service'
import { PerBoxLimits } from '../../box/services/per-box-limits'

const DEFAULT_LIMITS: PerBoxLimits = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }
const CACHE_TTL_SECONDS = 30
const CACHE_TIMEOUT_MS = 1_000
const CACHE_KEY_PREFIX = 'commerce:box-resource-limits:v1:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolves creation entitlements without persisting them over administrator quotas. */
@Injectable()
export class OrganizationBoxLimitsService {
  private readonly logger = new Logger(OrganizationBoxLimitsService.name)
  // Redis shares completed grants; concurrent misses are coalesced within this process.
  private readonly inFlightResolutions = new Map<string, Promise<PerBoxLimits>>()

  constructor(
    private readonly configService: TypedConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async resolve(organization: PerBoxLimits & { id: string }): Promise<PerBoxLimits> {
    const { maxCpuPerBox, maxMemoryPerBox, maxDiskPerBox } = organization
    const stored = { maxCpuPerBox, maxMemoryPerBox, maxDiskPerBox }
    if (!this.hasDefaultLimits(stored)) return stored

    const baseUrl = this.configService.get('billingApiUrl')?.trim()
    if (!baseUrl) return stored

    try {
      const token = this.configService.get('usageExport.token')?.trim()
      if (!token) throw new Error('Commerce authentication is not configured')
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid Commerce URL')
      }
      const cacheKey = `${CACHE_KEY_PREFIX}${encodeURIComponent(organization.id)}`
      let resolution = this.inFlightResolutions.get(cacheKey)
      if (!resolution) {
        resolution = this.resolveFromCacheOrCommerce(organization.id, cacheKey, baseUrl, token).finally(() => {
          this.inFlightResolutions.delete(cacheKey)
        })
        this.inFlightResolutions.set(cacheKey, resolution)
      }
      return { ...(await resolution) }
    } catch {
      // Never inherit the concurrency gate's fail-open policy for a paid resource grant.
      this.logger.warn(`Unable to verify subscription Box limits for organization ${organization.id}; using defaults`)
      return stored
    }
  }

  private hasDefaultLimits(limits: PerBoxLimits): boolean {
    return Object.entries(DEFAULT_LIMITS).every(([key, value]) => limits[key] === value)
  }

  private async resolveFromCacheOrCommerce(
    organizationId: string,
    cacheKey: string,
    baseUrl: string,
    token: string,
  ): Promise<PerBoxLimits> {
    const cached = await this.getCachedLimits(cacheKey)
    if (cached) return cached

    const { data } = await axios.get<unknown>(
      `${baseUrl.replace(/\/+$/, '')}/organization/${encodeURIComponent(organizationId)}/plan`,
      { timeout: 2_000, maxRedirects: 0, headers: { authorization: `Bearer ${token}` } },
    )
    const limits = this.parseLimits(data) ?? { ...DEFAULT_LIMITS }
    await this.cacheLimits(cacheKey, limits)
    return limits
  }

  private async getCachedLimits(cacheKey: string): Promise<PerBoxLimits | undefined> {
    try {
      const cached = await this.withCacheTimeout(this.redis.get(cacheKey))
      if (cached === null) return undefined
      const record: unknown = JSON.parse(cached)
      if (!isRecord(record) || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) {
        throw new Error('Invalid cached Box limits')
      }
      if (record.expiresAt <= Date.now()) return undefined
      return this.parseLimitValues(record.limits)
    } catch {
      this.logger.warn(`Unable to read Box resource limit cache for ${cacheKey}; checking Commerce`)
      return undefined
    }
  }

  private async cacheLimits(cacheKey: string, limits: PerBoxLimits): Promise<void> {
    // A timed-out Redis write can finish later; absolute expiry prevents reviving an old grant.
    const record = { limits, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1_000 }
    try {
      await this.withCacheTimeout(this.redis.set(cacheKey, JSON.stringify(record), 'EX', CACHE_TTL_SECONDS))
    } catch {
      this.logger.warn(`Unable to write Box resource limit cache for ${cacheKey}; keeping verified limits`)
    }
  }

  private async withCacheTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Box resource limit cache timed out')), CACHE_TIMEOUT_MS)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private parseLimits(data: unknown): PerBoxLimits | undefined {
    if (!isRecord(data)) throw new Error('Invalid organization plan response')
    if (Object.keys(data).length === 0) return undefined
    const plan = data.plan
    if (!isRecord(plan)) throw new Error('Invalid organization plan')
    // Commerce owns eligibility; consume its effective grant without reinterpreting subscription metadata.
    // An older Commerce deployment has no resource grant yet.
    if (plan.perBoxLimits === undefined) return undefined
    return this.parseLimitValues(plan.perBoxLimits)
  }

  private parseLimitValues(limits: unknown): PerBoxLimits {
    if (!isRecord(limits)) throw new Error('Invalid Box limits')
    const result = {} as PerBoxLimits
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof PerBoxLimits)[]) {
      const value = limits[key]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Invalid Box limit')
      }
      result[key] = value
    }
    return result
  }
}
