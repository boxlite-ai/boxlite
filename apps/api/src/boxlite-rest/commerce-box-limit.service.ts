/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { Redis } from 'ioredis'
import { TypedConfigService } from '../config/typed-config.service'
import { BoxCreationAdmissionUnavailableError } from '../box/errors/box-creation-limit.error'

const COMMERCE_REQUEST_TIMEOUT_MS = 2_000
const COMMERCE_BOX_LIMIT_CACHE_KEY_PREFIX = 'commerce:box-limit:v1:'
const COMMERCE_BOX_LIMIT_CACHE_TTL_SECONDS = 30
const UNLIMITED_CACHE_VALUE = 'unlimited'
const LIMIT_CACHE_VALUE_PREFIX = 'limit:'

type PublicPlan = {
  id: string
  concurrencyLimit: number | null
}

type OrganizationPlan = {
  planId: string
  entitlements?: 'active' | 'suspended'
}

type CachedBoxLimit = { hit: true; maxCreatedBoxes: number | undefined } | { hit: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

@Injectable()
export class CommerceBoxLimitService {
  private readonly logger = new Logger(CommerceBoxLimitService.name)
  private readonly inFlightResolutions = new Map<string, Promise<number | undefined>>()

  constructor(
    private readonly configService: TypedConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async resolveMaxCreatedBoxes(organizationId: string): Promise<number | undefined> {
    const rawBaseUrl = this.configService.get('billingApiUrl')?.trim()
    if (!rawBaseUrl) {
      return undefined
    }

    const token = this.configService.get('usageExport.token')?.trim()
    if (!token) {
      throw new BoxCreationAdmissionUnavailableError('Commerce authentication is not configured')
    }

    const baseUrl = this.normalizeBaseUrl(rawBaseUrl)
    const cacheKey = `${COMMERCE_BOX_LIMIT_CACHE_KEY_PREFIX}${encodeURIComponent(organizationId)}`
    const inFlightResolution = this.inFlightResolutions.get(cacheKey)
    if (inFlightResolution) {
      return inFlightResolution
    }

    const resolution = this.resolveFromCacheOrCommerce(organizationId, cacheKey, baseUrl, token).finally(() => {
      this.inFlightResolutions.delete(cacheKey)
    })
    this.inFlightResolutions.set(cacheKey, resolution)

    return resolution
  }

  private async resolveFromCacheOrCommerce(
    organizationId: string,
    cacheKey: string,
    baseUrl: string,
    token: string,
  ): Promise<number | undefined> {
    const cachedLimit = await this.getCachedLimit(cacheKey)
    if (cachedLimit.hit) {
      return cachedLimit.maxCreatedBoxes
    }

    const maxCreatedBoxes = await this.fetchMaxCreatedBoxes(organizationId, baseUrl, token)
    await this.cacheResolvedLimit(cacheKey, maxCreatedBoxes)
    return maxCreatedBoxes
  }

  private async getCachedLimit(cacheKey: string): Promise<CachedBoxLimit> {
    let cached: string | null
    try {
      cached = await this.redis.get(cacheKey)
    } catch {
      this.logger.warn(`Failed to read Commerce box limit cache for ${cacheKey}; falling back to Commerce`)
      return { hit: false }
    }

    if (cached === null) {
      return { hit: false }
    }
    if (cached === UNLIMITED_CACHE_VALUE) {
      return { hit: true, maxCreatedBoxes: undefined }
    }

    if (cached.startsWith(LIMIT_CACHE_VALUE_PREFIX)) {
      const rawLimit = cached.slice(LIMIT_CACHE_VALUE_PREFIX.length)
      const limit = Number(rawLimit)
      if (/^(0|[1-9]\d*)$/.test(rawLimit) && Number.isSafeInteger(limit)) {
        return { hit: true, maxCreatedBoxes: limit }
      }
    }

    this.logger.warn(`Ignoring invalid Commerce box limit cache value for ${cacheKey}`)
    return { hit: false }
  }

  private async cacheResolvedLimit(cacheKey: string, maxCreatedBoxes: number | undefined): Promise<void> {
    const cachedValue =
      maxCreatedBoxes === undefined ? UNLIMITED_CACHE_VALUE : `${LIMIT_CACHE_VALUE_PREFIX}${maxCreatedBoxes}`

    try {
      await this.redis.set(cacheKey, cachedValue, 'EX', COMMERCE_BOX_LIMIT_CACHE_TTL_SECONDS)
    } catch {
      this.logger.warn(`Failed to write Commerce box limit cache for ${cacheKey}`)
    }
  }

  private async fetchMaxCreatedBoxes(
    organizationId: string,
    baseUrl: string,
    token: string,
  ): Promise<number | undefined> {
    const requestConfig = {
      timeout: COMMERCE_REQUEST_TIMEOUT_MS,
      headers: { authorization: `Bearer ${token}` },
    }

    let responses: [{ data: unknown }, { data: unknown }]
    try {
      responses = await Promise.all([
        axios.get<unknown>(`${baseUrl}/plan`, requestConfig),
        axios.get<unknown>(`${baseUrl}/organization/${encodeURIComponent(organizationId)}/plan`, requestConfig),
      ])
    } catch {
      throw new BoxCreationAdmissionUnavailableError('Commerce plan service is unavailable')
    }

    const [catalogResponse, organizationPlanResponse] = responses
    const catalog = this.parseCatalog(catalogResponse.data)
    const organizationPlan = this.parseOrganizationPlan(organizationPlanResponse.data)
    const selectedPlan =
      !organizationPlan || organizationPlan.entitlements === 'suspended'
        ? catalog[0]
        : catalog.find((plan) => plan.id === organizationPlan.planId)

    // A plan absent from the public catalog may be a negotiated subscription;
    // leave it unlimited until Commerce exposes its effective limit.
    return selectedPlan?.concurrencyLimit ?? undefined
  }

  private normalizeBaseUrl(rawBaseUrl: string): string {
    let parsed: URL
    try {
      parsed = new URL(rawBaseUrl)
    } catch {
      throw new BoxCreationAdmissionUnavailableError('Commerce API URL is invalid')
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new BoxCreationAdmissionUnavailableError('Commerce API URL is invalid')
    }

    return rawBaseUrl.replace(/\/+$/, '')
  }

  private parseCatalog(value: unknown): PublicPlan[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an empty or invalid plan catalog')
    }

    return value.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
        throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid plan catalog')
      }

      const concurrencyLimit = candidate.concurrencyLimit
      if (
        concurrencyLimit !== null &&
        (typeof concurrencyLimit !== 'number' || !Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 0)
      ) {
        throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid box concurrency limit')
      }

      return { id: candidate.id, concurrencyLimit: concurrencyLimit as number | null }
    })
  }

  private parseOrganizationPlan(value: unknown): OrganizationPlan | undefined {
    if (!isRecord(value)) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }

    if (!Object.prototype.hasOwnProperty.call(value, 'plan')) {
      if (Object.keys(value).length === 0) {
        return undefined
      }
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }

    const plan = value.plan
    if (!isRecord(plan) || typeof plan.planId !== 'string' || plan.planId.length === 0) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }
    if (plan.entitlements !== undefined && !['active', 'suspended'].includes(plan.entitlements as string)) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned invalid organization entitlements')
    }

    return {
      planId: plan.planId,
      entitlements: plan.entitlements as OrganizationPlan['entitlements'],
    }
  }
}
