import { z } from 'zod'

const receiptSchema = z.discriminatedUnion('outcome', [
  z.object({
    eventId: z.uuid(),
    organizationId: z.uuid(),
    outcome: z.literal('processed'),
    replayed: z.boolean(),
    reason: z.null(),
    result: z.object({
      scene: z.literal('InvitationReward'),
      creditCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      couponId: z.uuid(),
      redemptionId: z.uuid(),
      walletTransactionId: z.uuid(),
    }),
  }),
  z.object({
    eventId: z.uuid(),
    organizationId: z.uuid(),
    outcome: z.literal('skipped'),
    replayed: z.boolean(),
    reason: z.literal('reward_limit_reached'),
    result: z.null(),
  }),
])

export function parseBusinessEventReceipt(value: unknown, eventId: string, organizationId: string) {
  const receipt = receiptSchema.safeParse(value)
  if (!receipt.success || receipt.data.eventId !== eventId || receipt.data.organizationId !== organizationId)
    return null
  return receipt.data
}

export function retryDelayMs(attempt: number, maxBackoffMs: number, retryAfter?: string, now = Date.now()): number {
  const ceiling = Math.min(maxBackoffMs, 1_000 * 2 ** Math.min(attempt, 30))
  const jittered = Math.max(1_000, Math.floor(ceiling * (0.5 + Math.random() / 2)))
  if (!retryAfter) return jittered
  const earliest = /^\d+$/.test(retryAfter.trim()) ? now + Number(retryAfter) * 1_000 : Date.parse(retryAfter)
  return Number.isFinite(earliest) && Math.abs(earliest) <= 8_640_000_000_000_000
    ? Math.max(jittered, earliest - now)
    : jittered
}
