import { randomUUID } from 'node:crypto'
import { parseBusinessEventReceipt, retryDelayMs } from './business-event-receipt'

describe('P01/P04 Commerce receipts and retry timing', () => {
  const eventId = randomUUID(),
    organizationId = randomUUID()
  const receipt = {
    eventId,
    organizationId,
    outcome: 'processed',
    replayed: false,
    reason: null,
    result: {
      scene: 'InvitationReward',
      creditCents: 137,
      couponId: randomUUID(),
      redemptionId: randomUUID(),
      walletTransactionId: randomUUID(),
    },
  }
  it('accepts processed and replayed results', () => {
    expect(parseBusinessEventReceipt(receipt, eventId, organizationId)?.outcome).toBe('processed')
    expect(parseBusinessEventReceipt({ ...receipt, replayed: true }, eventId, organizationId)?.replayed).toBe(true)
  })
  it('accepts a limit skip with no reward', () => {
    expect(
      parseBusinessEventReceipt(
        { ...receipt, outcome: 'skipped', reason: 'reward_limit_reached', result: null },
        eventId,
        organizationId,
      )?.outcome,
    ).toBe('skipped')
  })
  it.each([
    { eventId: randomUUID() },
    { organizationId: randomUUID() },
    { replayed: undefined },
    { result: null },
    { reason: 'unexpected' },
    { result: { ...receipt.result, creditCents: 0 } },
    { result: { ...receipt.result, creditCents: 0.5 } },
    { result: { ...receipt.result, walletTransactionId: 'bad' } },
    { outcome: 'skipped', reason: 'reward_limit_reached' },
  ])('rejects missing/mismatched or malformed receipt %p', (change) => {
    expect(parseBusinessEventReceipt({ ...receipt, ...change }, eventId, organizationId)).toBeNull()
  })
  it('honors Retry-After beyond the local backoff cap', () => {
    expect(retryDelayMs(10, 900000, '3600', 0)).toBe(3600000)
    expect(retryDelayMs(10, 900000, new Date(3600000).toUTCString(), 0)).toBe(3600000)
    expect(retryDelayMs(10, 900000, 'invalid', 0)).toBeLessThanOrEqual(900000)
    expect(retryDelayMs(1, 900000, undefined, 0)).toBeGreaterThanOrEqual(1000)
    expect(retryDelayMs(10, 900000, '99999999999999999999', 0)).toBeLessThanOrEqual(900000)
  })
})
