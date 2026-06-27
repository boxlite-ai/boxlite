/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Pure wallet math — the dual-pool (free → paid) burn-down, top-up settlement,
 * and billing-status derivation. No DB, no I/O; the WalletService wraps these in
 * an optimistic-locked transaction and writes append-only transaction rows.
 *
 * Grounded in Lago's per-lot `remaining_amount_cents` FIFO burn + `lock_version`
 * optimistic locking, and OpenMeter's "status is derived, not stored" rule
 * (`StatusAt`). All amounts are integer cents (never float).
 */

export type Pool = 'free' | 'paid'

/** Stored billing status (the only states persisted; low/zero are derived). */
export type StoredBillingStatus = 'trial' | 'active' | 'suspended' | 'closed'

/** The full billing status surfaced to callers (derived states included). */
export type BillingStatus = 'trial' | 'active' | 'low_balance' | 'zero_balance' | 'suspended' | 'closed'

/** One inbound credit lot (a top-up or grant) with a running remaining balance. */
export interface InboundLot {
  id: string
  pool: Pool
  /** free = 1, paid = 2 — lower drains first. */
  priority: number
  remainingCents: number
  /** Lot expires (free credits); `null` = never. */
  expiresAt: Date | null
  createdAt: Date
}

/** One debit against a specific lot. */
export interface LotDebit {
  lotId: string
  pool: Pool
  cents: number
}

/** Result of burning an amount across the available lots. */
export interface BurnResult {
  debits: LotDebit[]
  /** Amount that could not be covered by any lot (drives bounded-negative overage). */
  overageCents: number
}

/**
 * Order lots for consumption: lower priority first (free before paid), then
 * soonest-expiring first (use credits before they lapse), then oldest first
 * (FIFO tie-break). Lots already expired at `now` are excluded.
 *
 * NOTE: the SQL `ORDER BY` that mirrors this is left as a TODO pending a `gh`
 * confirm of Lago's exact `in_consumption_order` (2-key vs 3-key with a
 * granted/purchased CASE); this explicit-priority form is correct for both.
 */
function consumptionOrder(lots: InboundLot[], now: Date): InboundLot[] {
  return lots
    .filter((l) => l.remainingCents > 0 && (l.expiresAt === null || l.expiresAt.getTime() > now.getTime()))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY
      const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY
      if (ax !== bx) return ax - bx
      return a.createdAt.getTime() - b.createdAt.getTime()
    })
}

/**
 * Burn `amountCents` across the lots in consumption order, draining each lot to
 * zero before moving on. Returns the per-lot debits and any uncovered overage
 * (the bounded-negative amount that gets carried until the next top-up).
 */
export function burnDown(lots: InboundLot[], amountCents: number, now: Date): BurnResult {
  if (amountCents <= 0) return { debits: [], overageCents: 0 }

  const debits: LotDebit[] = []
  let remaining = amountCents

  for (const lot of consumptionOrder(lots, now)) {
    if (remaining <= 0) break
    const take = Math.min(lot.remainingCents, remaining)
    debits.push({ lotId: lot.id, pool: lot.pool, cents: take })
    remaining -= take
  }

  return { debits, overageCents: remaining }
}

/** What a top-up does: clear any carried negative balance first, the rest funds the paid pool. */
export interface TopUpPlan {
  /** Cents used to settle a prior bounded-negative balance (no new spendable credit). */
  settleNegativeCents: number
  /** Cents that become a fresh spendable paid-pool lot. */
  toPaidPoolCents: number
}

/**
 * Apply a top-up against the current (possibly negative) balance: a negative
 * balance is settled first, only the surplus becomes spendable paid credit.
 */
export function applyTopUp(currentBalanceCents: number, topUpCents: number): TopUpPlan {
  if (topUpCents <= 0) return { settleNegativeCents: 0, toPaidPoolCents: 0 }

  const deficit = currentBalanceCents < 0 ? -currentBalanceCents : 0
  const settle = Math.min(deficit, topUpCents)
  return { settleNegativeCents: settle, toPaidPoolCents: topUpCents - settle }
}

/**
 * Derive the surfaced billing status. `suspended` / `closed` / `trial` are
 * authoritative (stored); `active` refines into `low_balance` / `zero_balance`
 * from the live balance so the two can never drift out of sync.
 */
export function deriveBillingStatus(
  stored: StoredBillingStatus,
  balanceCents: number,
  warnThresholdCents: number,
): BillingStatus {
  if (stored !== 'active') return stored
  if (balanceCents <= 0) return 'zero_balance'
  if (balanceCents <= warnThresholdCents) return 'low_balance'
  return 'active'
}
