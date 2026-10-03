/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { v5 as uuidv5, validate as isUuid } from 'uuid'
import { TypedConfigService } from '../config/typed-config.service'
import { CommerceConflictError, CommerceUnavailableError } from './commerce.errors'

// Account creation waits on these calls, and holds its transaction open while
// the referral event is sent.
const COMMERCE_INTERNAL_TIMEOUT_MS = 5_000

// Commerce's own format (boxlite-commerce src/referral-codes/policy/referral-code.ts).
// Checking it here keeps a code Commerce would reject from costing a request.
const REFERRAL_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/

// Commerce's inviteeEmail rule (boxlite-commerce src/billing-events/api/dto/billing-event.dto.ts).
const MAX_INVITEE_EMAIL_LENGTH = 254

// Every referral eventId is derived from the account ID under this namespace, so
// a retry resends its first attempt's delivery ID, as Commerce asks after a lost
// response or an uncertain commit. Commerce counts each invitee once regardless.
const REFERRAL_EVENT_NAMESPACE = '9759f4dd-2b29-4b3d-85a2-ca511d74c9ab'

// Commerce answers these when it cannot parse the event: a bug in this client, not an outage.
const MALFORMED_EVENT_STATUSES = new Set([400, 413, 422])

/** The account a referral event reports to the inviting organization. */
export interface ReferralInvitee {
  id: string
  email: string
  createdAt: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// C0 and C1 control characters, which Commerce rejects anywhere in the email.
function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
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

  /**
   * Whether Commerce would accept this email in a referral event. Checking it
   * before any write lets a sign-up it would refuse fail without leaving rows.
   */
  acceptsInviteeEmail(email: string | undefined): boolean {
    return (
      typeof email === 'string' &&
      email.length > 0 &&
      email.length <= MAX_INVITEE_EMAIL_LENGTH &&
      email.includes('@') &&
      !Array.from(email).some(isControlCharacter)
    )
  }

  /**
   * Reports to the inviting organization that its referral created this account.
   * Commerce accepts the event and grants the reward later.
   *
   * @throws CommerceConflictError when another organization already referred the account.
   * @throws CommerceUnavailableError when Commerce does not accept the event.
   */
  async publishReferralNewer(inviterOrganizationId: string, invitee: ReferralInvitee): Promise<void> {
    const { baseUrl, token } = this.connection()

    let response: { status: number }
    try {
      response = await axios.post(
        `${baseUrl}/internal/organization/${encodeURIComponent(inviterOrganizationId)}/billing-events`,
        referralNewerEvent(invitee),
        {
          timeout: COMMERCE_INTERNAL_TIMEOUT_MS,
          headers: { authorization: `Bearer ${token}` },
          // Any 2xx means accepted; its body only reports Commerce's progress.
          validateStatus: (status) => (status >= 200 && status < 300) || status === 409,
        },
      )
    } catch (error) {
      throw this.malformedEvent(error) ?? this.unavailable('referral event delivery', error)
    }

    if (response.status === 409) {
      throw new CommerceConflictError(
        `Commerce refused the referral event for user ${invitee.id}: another organization already referred it`,
      )
    }
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

  // An error, not a warning: the event needs a fix here, and retrying cannot help.
  // Commerce's message is a fixed validation string; the request config stays out.
  private malformedEvent(error: unknown): CommerceUnavailableError | undefined {
    const response = isRecord(error) ? error.response : undefined
    if (!isRecord(response) || typeof response.status !== 'number' || !MALFORMED_EVENT_STATUSES.has(response.status)) {
      return undefined
    }
    const reason = isRecord(response.data) ? response.data.message : undefined
    const message = `Commerce rejected the referral event as malformed (HTTP ${response.status})${
      typeof reason === 'string' ? `: ${reason.slice(0, 200)}` : ''
    }`
    this.logger.error(message)
    return new CommerceUnavailableError(message)
  }
}

// Exactly the four fields Commerce's contract allows; it rejects any other.
function referralNewerEvent(invitee: ReferralInvitee) {
  return {
    eventId: uuidv5(invitee.id, REFERRAL_EVENT_NAMESPACE),
    type: 'referral-newer',
    occurredAt: invitee.createdAt.toISOString(),
    data: { inviteeUserId: invitee.id, inviteeEmail: invitee.email },
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
