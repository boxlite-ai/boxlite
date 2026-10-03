/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { validate as isUuid } from 'uuid'
import { TypedConfigService } from '../config/typed-config.service'
import { CommerceUnavailableError } from './commerce.errors'

// Account creation waits on this call.
const COMMERCE_INTERNAL_TIMEOUT_MS = 5_000

// Commerce's own format (boxlite-commerce src/referral-codes/policy/referral-code.ts).
// Checking it here keeps a code Commerce would reject from costing a request.
const REFERRAL_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Server-to-server calls to Commerce's internal routes, authenticated with the
 * shared service token. Those routes are served off Commerce's bare origin,
 * outside the /api/billing prefix that BILLING_API_URL carries.
 */
@Injectable()
export class CommerceInternalClient {
  private readonly logger = new Logger(CommerceInternalClient.name)

  constructor(private readonly configService: TypedConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get('billingApiUrl') && this.configService.get('usageExport.token'))
  }

  /**
   * Resolves a referral code to the organization that issued it.
   *
   * @returns the inviting organization's id, or null when the value cannot be a
   * referral code or Commerce does not know it.
   * @throws CommerceUnavailableError when Commerce cannot answer.
   */
  async resolveReferralCode(rawCode: string): Promise<string | null> {
    const { baseUrl, token } = this.connection()
    const code = rawCode.trim().toUpperCase()
    if (!REFERRAL_CODE_PATTERN.test(code)) {
      return null
    }

    let response: { status: number; data: unknown }
    try {
      response = await axios.get<unknown>(`${baseUrl}/internal/organization`, {
        params: { 'referral-code': code },
        timeout: COMMERCE_INTERNAL_TIMEOUT_MS,
        headers: { authorization: `Bearer ${token}` },
        validateStatus: (status) => status === 200 || status === 404,
      })
    } catch (error) {
      throw this.unavailable('referral code lookup', error)
    }

    if (response.status === 404) {
      return null
    }
    const organizationId = isRecord(response.data) ? response.data.organizationId : undefined
    if (typeof organizationId !== 'string' || !isUuid(organizationId)) {
      this.logger.error('Commerce referral code lookup returned no organization uuid')
      throw new CommerceUnavailableError('Commerce returned a malformed referral code lookup')
    }
    return organizationId
  }

  private connection(): { baseUrl: string; token: string } {
    const billingApiUrl = this.configService.get('billingApiUrl')
    const token = this.configService.get('usageExport.token')
    if (!billingApiUrl || !token) {
      throw new CommerceUnavailableError('Commerce is not configured')
    }
    // USAGE_EXPORT_URL is where usage export already reaches these routes, but
    // configuration.ts validates it only while export or snapshots are on; a
    // stage that leaves both off may hold a placeholder there.
    const usageExportUrl = this.configService.get('usageExport.url')
    const exporting =
      this.configService.get('usageExport.enabled') || this.configService.get('usageExport.allocationSnapshotEnabled')
    return { baseUrl: exporting && usageExportUrl ? usageExportUrl : new URL(billingApiUrl).origin, token }
  }

  // An axios error carries the request config, bearer token included, so only
  // the status or transport code may reach the log and the error.
  private unavailable(operation: string, error: unknown): CommerceUnavailableError {
    const message = `Commerce ${operation} is unavailable (${failureReason(error)})`
    this.logger.warn(message)
    return new CommerceUnavailableError(message)
  }
}

function failureReason(error: unknown): string {
  if (!isRecord(error)) {
    return 'request failed'
  }
  const response = error.response
  if (isRecord(response) && typeof response.status === 'number') {
    return `HTTP ${response.status}`
  }
  return typeof error.code === 'string' ? error.code : 'transport failure'
}
