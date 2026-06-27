/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { applyTopUp, burnDown, InboundLot, Pool } from './wallet-math'
import { TxSource } from '../entities/wallet-transaction.entity'

/**
 * Higher-level wallet planners — pure functions that turn a debit / top-up /
 * grant into "which ledger rows to write, which lots to burn, and the wallet's
 * new materialized balances". No DB: the WalletService loads the state inside an
 * optimistic-locked transaction, calls a planner, then persists the plan. Keeping
 * the money arithmetic here makes every balance transition unit-testable, and
 * preserves the core invariant: `balanceCents == SUM(ledger)`, and whenever
 * `balanceCents >= 0` it equals `freeBalanceCents + paidBalanceCents`.
 */

export const FREE_PRIORITY = 1
export const PAID_PRIORITY = 2

/** The materialized balance triple carried on the wallet row. */
export interface WalletBalances {
  /** Signed authoritative balance (can be bounded-negative on overage). */
  balanceCents: number
  freeBalanceCents: number
  paidBalanceCents: number
}

/** A ledger row to insert (shape mirrors WalletTransaction's writable columns). */
export interface PlannedLedgerRow {
  pool: Pool
  priority: number
  direction: 'inbound' | 'outbound'
  amountCents: number
  /** Inbound: spendable remaining of this lot. Outbound: null. */
  remainingCents: number | null
  expiresAt: Date | null
  source: TxSource
  ratedPeriodId: string | null
}

/** A decrement to apply to an existing inbound lot's remaining balance. */
export interface LotBurn {
  lotId: string
  newRemainingCents: number
}

export interface DebitPlan {
  balances: WalletBalances
  ledgerRows: PlannedLedgerRow[]
  lotBurns: LotBurn[]
  overageCents: number
}

export interface CreditPlan {
  balances: WalletBalances
  ledgerRow: PlannedLedgerRow
  /** Cents that paid down a prior bounded-negative balance (no spendable credit). */
  settledNegativeCents: number
}

const sumByPool = (debits: { pool: Pool; cents: number }[], pool: Pool) =>
  debits.filter((d) => d.pool === pool).reduce((s, d) => s + d.cents, 0)

/**
 * Plan a usage debit: burn free→paid across the lots, write one outbound ledger
 * row per burned lot (plus one uncovered-overage row so the ledger still sums to
 * the full amount), and drop the signed balance by the full amount — letting it
 * go bounded-negative when usage outruns the pools.
 */
export function planDebit(
  balances: WalletBalances,
  lots: InboundLot[],
  amountCents: number,
  now: Date,
  opts: { source: TxSource; ratedPeriodId: string | null },
): DebitPlan {
  const burn = burnDown(lots, amountCents, now)
  const byId = new Map(lots.map((l) => [l.id, l]))

  const ledgerRows: PlannedLedgerRow[] = burn.debits.map((d) => ({
    pool: d.pool,
    priority: d.pool === 'free' ? FREE_PRIORITY : PAID_PRIORITY,
    direction: 'outbound',
    amountCents: d.cents,
    remainingCents: null,
    expiresAt: null,
    source: opts.source,
    ratedPeriodId: opts.ratedPeriodId,
  }))

  if (burn.overageCents > 0) {
    // Uncovered usage — a debt row backed by no lot, so SUM(ledger) stays exact.
    ledgerRows.push({
      pool: 'paid',
      priority: PAID_PRIORITY,
      direction: 'outbound',
      amountCents: burn.overageCents,
      remainingCents: null,
      expiresAt: null,
      source: opts.source,
      ratedPeriodId: opts.ratedPeriodId,
    })
  }

  const lotBurns: LotBurn[] = burn.debits.map((d) => ({
    lotId: d.lotId,
    newRemainingCents: (byId.get(d.lotId)?.remainingCents ?? 0) - d.cents,
  }))

  return {
    balances: {
      balanceCents: balances.balanceCents - amountCents,
      freeBalanceCents: balances.freeBalanceCents - sumByPool(burn.debits, 'free'),
      paidBalanceCents: balances.paidBalanceCents - sumByPool(burn.debits, 'paid'),
    },
    ledgerRows,
    lotBurns,
    overageCents: burn.overageCents,
  }
}

/**
 * Plan an inbound credit (top-up → paid pool, grant → free pool). A carried
 * negative balance is settled first; only the surplus becomes a spendable lot.
 * The lot's `amountCents` is the full credit, but its `remainingCents` is just
 * the spendable surplus, so the settled part can never be double-spent.
 */
export function planCredit(
  balances: WalletBalances,
  amountCents: number,
  pool: Pool,
  opts: { source: TxSource; expiresAt: Date | null },
): CreditPlan {
  const { settleNegativeCents, toPaidPoolCents: spendable } = applyTopUp(balances.balanceCents, amountCents)

  return {
    balances: {
      balanceCents: balances.balanceCents + amountCents,
      freeBalanceCents: balances.freeBalanceCents + (pool === 'free' ? spendable : 0),
      paidBalanceCents: balances.paidBalanceCents + (pool === 'paid' ? spendable : 0),
    },
    ledgerRow: {
      pool,
      priority: pool === 'free' ? FREE_PRIORITY : PAID_PRIORITY,
      direction: 'inbound',
      amountCents,
      remainingCents: spendable,
      expiresAt: opts.expiresAt,
      source: opts.source,
      ratedPeriodId: null,
    },
    settledNegativeCents: settleNegativeCents,
  }
}
