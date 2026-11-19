/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import axios, { AxiosResponse } from 'axios'
import { z } from 'zod'
import { TypedConfigService } from '../../config/typed-config.service'

const eventType = 'RedeemCouponAfterBindCard'
const commerceTimeoutMs = 5_000
const couponRefusal = z.enum([
  'coupon_not_found',
  'coupon_wrong_organization',
  'coupon_already_redeemed',
  'coupon_disabled',
  'coupon_expired',
  'coupon_exhausted',
])
const refusalStatus: Record<z.infer<typeof couponRefusal>, number> = {
  coupon_not_found: 404,
  coupon_wrong_organization: 403,
  coupon_already_redeemed: 409,
  coupon_disabled: 409,
  coupon_expired: 409,
  coupon_exhausted: 409,
}
const refusalBody = z.object({ code: couponRefusal, message: z.string().min(1) })
const idConflict = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string().min(1),
  code: z.never().optional(),
})

const acceptedClaim = z
  .object({
    eventId: z.string(),
    organizationId: z.string(),
    type: z.literal(eventType),
    billingEventId: z.uuid(),
    replayed: z.boolean(),
  })
  .and(
    z.union([
      z.object({ status: z.enum(['pending', 'failed']), result: z.null() }),
      z.object({
        status: z.literal('done'),
        result: z.discriminatedUnion('outcome', [
          z.object({ outcome: z.literal('skipped'), reason: couponRefusal }),
          z.object({
            outcome: z.literal('processed'),
            creditCents: z.int().positive(),
            couponId: z.uuid(),
            redemptionId: z.uuid(),
            walletTransactionId: z.uuid(),
          }),
        ]),
      }),
    ]),
  )

@Injectable()
export class CouponClaimsService {
  private readonly logger = new Logger(CouponClaimsService.name)
  constructor(private readonly config: TypedConfigService) {}

  async submit(organizationId: string, eventId: string, couponCode: string) {
    const baseUrl = this.config.get('usageExport.url')
    const token = this.config.get('usageExport.token')
    if (!this.config.get('billingApiUrl') || !baseUrl || !token) {
      throw new ServiceUnavailableException('Coupon claims are unavailable')
    }

    let response: AxiosResponse<unknown>
    try {
      response = await axios.post<unknown>(
        `${baseUrl}/internal/organization/${encodeURIComponent(organizationId)}/billing-events`,
        { eventId, type: eventType, occurredAt: new Date().toISOString(), data: { coupon_code: couponCode } },
        {
          signal: AbortSignal.timeout(commerceTimeoutMs),
          maxRedirects: 0,
          headers: { authorization: `Bearer ${token}` },
          validateStatus: () => true,
        },
      )
    } catch {
      throw this.unavailable(eventId)
    }

    if (response.status === 202) {
      const receipt = acceptedClaim.safeParse(response.data)
      if (receipt.success && receipt.data.organizationId === organizationId && receipt.data.eventId === eventId) {
        const { status, result } = receipt.data
        return { status, result }
      }
    } else {
      const refusal = refusalBody.safeParse(response.data)
      if (refusal.success && refusalStatus[refusal.data.code] === response.status) {
        throw new HttpException(refusal.data, response.status)
      }
      if (response.status === 409 && idConflict.safeParse(response.data).success) {
        throw new ConflictException({
          code: 'coupon_claim_conflict',
          message: 'This event ID belongs to another claim',
        })
      }
    }
    throw this.unavailable(eventId, response.status)
  }

  private unavailable(eventId: string, status?: number): ServiceUnavailableException {
    this.logger.warn(`Could not confirm coupon claim ${eventId} with Commerce${status ? ` (HTTP ${status})` : ''}`)
    return new ServiceUnavailableException('Unable to confirm the coupon claim. Retry with the same event ID.')
  }
}
