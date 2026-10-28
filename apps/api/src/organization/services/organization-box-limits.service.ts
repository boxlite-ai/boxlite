/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'
import { PerBoxLimits } from '../../box/services/per-box-limits'

const DEFAULT_LIMITS: PerBoxLimits = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolves creation entitlements without persisting them over administrator quotas. */
@Injectable()
export class OrganizationBoxLimitsService {
  private readonly logger = new Logger(OrganizationBoxLimitsService.name)

  constructor(private readonly configService: TypedConfigService) {}

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
      const { data } = await axios.get<unknown>(
        `${baseUrl.replace(/\/+$/, '')}/organization/${encodeURIComponent(organization.id)}/plan`,
        { timeout: 2_000, maxRedirects: 0, headers: { authorization: `Bearer ${token}` } },
      )
      return this.parseLimits(data) ?? stored
    } catch {
      // Never inherit the concurrency gate's fail-open policy for a paid resource grant.
      this.logger.warn(`Unable to verify subscription Box limits for organization ${organization.id}; using defaults`)
      return stored
    }
  }

  private hasDefaultLimits(limits: PerBoxLimits): boolean {
    return Object.entries(DEFAULT_LIMITS).every(([key, value]) => limits[key] === value)
  }

  private parseLimits(data: unknown): PerBoxLimits | undefined {
    if (!isRecord(data)) throw new Error('Invalid organization plan response')
    if (Object.keys(data).length === 0) return undefined
    const plan = data.plan
    if (!isRecord(plan)) throw new Error('Invalid organization plan')
    // Commerce owns eligibility; consume its effective grant without reinterpreting subscription metadata.
    // An older Commerce deployment has no resource grant yet.
    if (plan.perBoxLimits === undefined) return undefined
    const limits = plan.perBoxLimits
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
