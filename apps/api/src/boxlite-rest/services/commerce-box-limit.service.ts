/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpService } from '@nestjs/axios'
import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { setTimeout as sleep } from 'node:timers/promises'
import { TypedConfigService } from '../../config/typed-config.service'

export type BoxLimit = { kind: 'limited'; value: number } | { kind: 'unlimited' }

type CatalogPlan = {
  id: string
  concurrencyLimit: number | null
}

type OrganizationPlan = {
  planId: string
}

type LimitResolution = {
  limit: BoxLimit
  isCacheable: boolean
}

const DEFAULT_BOX_LIMIT = 20
const LIMIT_CACHE_TTL_MS = 10_000
const COMMERCE_REQUEST_TIMEOUT_MS = 2_000
const COMMERCE_RETRY_DELAY_MS = 500

@Injectable()
export class CommerceBoxLimitService {
  private readonly logger = new Logger(CommerceBoxLimitService.name)
  private readonly cache = new Map<string, { limit: BoxLimit; expiresAt: number }>()
  private readonly inFlight = new Map<string, Promise<BoxLimit>>()

  constructor(
    private readonly httpService: HttpService,
    private readonly config: TypedConfigService,
  ) {}

  async resolveLimit(organizationId: string): Promise<BoxLimit> {
    const configuredBaseUrl = this.config.get('billingApiUrl')?.trim()
    if (!configuredBaseUrl) {
      return { kind: 'unlimited' }
    }

    const cached = this.cache.get(organizationId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.limit
    }
    if (cached) {
      this.cache.delete(organizationId)
    }

    const pending = this.inFlight.get(organizationId)
    if (pending) {
      return pending
    }

    const resolutionPromise = this.resolveConfiguredLimit(configuredBaseUrl, organizationId).then((resolution) => {
      if (resolution.isCacheable) {
        this.cache.set(organizationId, {
          limit: resolution.limit,
          expiresAt: Date.now() + LIMIT_CACHE_TTL_MS,
        })
      }
      return resolution.limit
    })
    this.inFlight.set(organizationId, resolutionPromise)

    try {
      return await resolutionPromise
    } finally {
      if (this.inFlight.get(organizationId) === resolutionPromise) {
        this.inFlight.delete(organizationId)
      }
    }
  }

  private async resolveConfiguredLimit(baseUrl: string, organizationId: string): Promise<LimitResolution> {
    const token = this.config.get('usageExport.token')?.trim()
    if (!token) {
      this.logger.warn(`Commerce box limit fallback for organization ${organizationId}: authentication token is missing`)
      return this.transientFallback()
    }

    let catalogUrl: string
    let organizationPlanUrl: string
    try {
      const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl)
      catalogUrl = `${normalizedBaseUrl}/plan`
      organizationPlanUrl = `${normalizedBaseUrl}/organization/${encodeURIComponent(organizationId)}/plan`
    } catch (error) {
      this.logger.warn(
        `Commerce box limit fallback for organization ${organizationId}: ${this.errorSummary(error)}`,
      )
      return this.transientFallback()
    }

    const [catalogResult, organizationPlanResult] = await Promise.allSettled([
      this.getCommerceJson(catalogUrl, 'plan catalog', token),
      this.getCommerceJson(organizationPlanUrl, 'organization plan', token),
    ])
    if (catalogResult.status === 'rejected') {
      this.logger.warn(
        `Commerce box limit fallback for organization ${organizationId}: ${this.errorSummary(catalogResult.reason)}`,
      )
      return this.transientFallback()
    }
    if (organizationPlanResult.status === 'rejected') {
      this.logger.warn(
        `Commerce box limit fallback for organization ${organizationId}: ${this.errorSummary(organizationPlanResult.reason)}`,
      )
      return this.transientFallback()
    }

    try {
      const catalog = this.parseCatalog(catalogResult.value)
      const organizationPlan = this.parseOrganizationPlan(organizationPlanResult.value)
      return { limit: this.matchLimit(catalog, organizationPlan), isCacheable: true }
    } catch (error) {
      this.logger.warn(
        `Commerce box limit fallback for organization ${organizationId}: ${this.errorSummary(error)}`,
      )
      return this.transientFallback()
    }
  }

  private async getCommerceJson(url: string, endpoint: string, token: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.httpService.axiosRef.get(url, {
          headers: { authorization: `Bearer ${token}` },
          timeout: COMMERCE_REQUEST_TIMEOUT_MS,
        })
        return response.data
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined
        if (attempt === 0 && status !== undefined && status >= 500 && status <= 599) {
          await sleep(COMMERCE_RETRY_DELAY_MS)
          continue
        }
        throw new Error(
          `request to ${endpoint} failed${status === undefined ? '' : ` with status ${status}`}`,
          { cause: error },
        )
      }
    }

    throw new Error(`request to ${endpoint} failed`)
  }

  private normalizeBaseUrl(value: string): string {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('BILLING_API_URL must be an absolute http(s) URL')
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('BILLING_API_URL is not valid for authenticated Commerce requests')
    }
    return value.replace(/\/+$/, '')
  }

  private parseCatalog(value: unknown): CatalogPlan[] {
    if (!Array.isArray(value)) {
      throw new Error('plan catalog response is malformed')
    }

    return value.map((entry) => {
      if (!this.isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error('plan catalog response is malformed')
      }
      if (
        entry.concurrencyLimit !== null &&
        (!Number.isSafeInteger(entry.concurrencyLimit) || (entry.concurrencyLimit as number) < 1)
      ) {
        throw new Error('plan catalog response is malformed')
      }
      return { id: entry.id, concurrencyLimit: entry.concurrencyLimit as number | null }
    })
  }

  private parseOrganizationPlan(value: unknown): OrganizationPlan | null {
    if (!this.isRecord(value)) {
      throw new Error('organization plan response is malformed')
    }
    if (Object.keys(value).length === 0) {
      return null
    }
    if (!this.isRecord(value.plan) || typeof value.plan.planId !== 'string' || value.plan.planId.length === 0) {
      throw new Error('organization plan response is malformed')
    }
    return { planId: value.plan.planId }
  }

  private matchLimit(catalog: CatalogPlan[], organizationPlan: OrganizationPlan | null): BoxLimit {
    if (catalog.length === 0) {
      return { kind: 'limited', value: DEFAULT_BOX_LIMIT }
    }

    const plan = organizationPlan ? catalog.find((entry) => entry.id === organizationPlan.planId) : catalog[0]
    if (!plan) {
      return { kind: 'limited', value: DEFAULT_BOX_LIMIT }
    }
    if (plan.concurrencyLimit === null) {
      return { kind: 'unlimited' }
    }
    return { kind: 'limited', value: plan.concurrencyLimit }
  }

  private transientFallback(): LimitResolution {
    return { limit: { kind: 'limited', value: DEFAULT_BOX_LIMIT }, isCacheable: false }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private errorSummary(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown Commerce error'
  }
}
