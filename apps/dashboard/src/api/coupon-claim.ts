/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */

import { z } from 'zod'

export const couponClaimReceipt = z.union([
  z.object({ status: z.enum(['pending', 'failed']), result: z.null() }),
  z.object({
    status: z.literal('done'),
    result: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('processed') }),
      z.object({ outcome: z.literal('skipped'), reason: z.string().min(1) }),
    ]),
  }),
])

export type CouponClaimReceipt = z.infer<typeof couponClaimReceipt>

export class CouponClaimUnconfirmedError extends Error {
  constructor() {
    super('We couldn’t confirm your reward claim. Please try again.')
  }
}
