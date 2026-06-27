/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource } from 'typeorm'
import { CreditGrant } from '../entities/credit-grant.entity'
import { Wallet } from '../entities/wallet.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
import { WalletService } from './wallet.service'

const T0 = new Date('2026-06-27T12:00:00Z')

type Insert = { entity: string; rows: unknown }
type Update = { entity: string; id: unknown; patch: Record<string, unknown> }

function makeService(wallet: Partial<Wallet>, lots: Partial<WalletTransaction>[]) {
  const walletRow = {
    id: 'w1',
    organizationId: 'org-1',
    balanceCents: '0',
    freeBalanceCents: '0',
    paidBalanceCents: '0',
    lockVersion: 0,
    billingStatus: 'active',
    creditCardConnected: false,
    ...wallet,
  } as Wallet

  const inserts: Insert[] = []
  const updates: Update[] = []
  const manager = {
    findOneOrFail: async () => walletRow,
    find: async () => lots,
    insert: async (entity: { name: string }, rows: unknown) => {
      inserts.push({ entity: entity.name, rows })
      return { identifiers: [{ id: 'tx-new' }] }
    },
    update: async (entity: { name: string }, id: unknown, patch: Record<string, unknown>) => {
      updates.push({ entity: entity.name, id, patch })
    },
  }
  const dataSource = {
    transaction: async (cb: (m: typeof manager) => unknown) => cb(manager),
    getRepository: () => ({ findOne: async () => walletRow }),
  } as unknown as DataSource

  return { service: new WalletService(dataSource), inserts, updates }
}

const lot = (id: string, pool: 'free' | 'paid', remainingCents: string): Partial<WalletTransaction> => ({
  id,
  pool,
  priority: pool === 'free' ? 1 : 2,
  remainingCents,
  expiresAt: null,
  createdAt: T0,
  direction: 'inbound',
  status: 'settled',
})

describe('WalletService.debit', () => {
  it('writes one outbound row per burned pool, decrements the lots, and updates the balance', async () => {
    const { service, inserts, updates } = makeService(
      { balanceCents: '800', freeBalanceCents: '300', paidBalanceCents: '500' },
      [lot('f', 'free', '300'), lot('p', 'paid', '500')],
    )

    const balances = await service.debit('org-1', 400, { source: 'usage', ratedPeriodId: 'rp-1' }, T0)

    expect(balances).toEqual({ balanceCents: 400, freeBalanceCents: 0, paidBalanceCents: 400 })

    // outbound ledger rows (free 300 + paid 100)
    const ledger = inserts.find((i) => i.entity === 'WalletTransaction')!.rows as Record<string, unknown>[]
    expect(ledger).toHaveLength(2)
    expect(ledger.map((r) => [r.pool, r.amountCents, r.direction])).toEqual([
      ['free', '300', 'outbound'],
      ['paid', '100', 'outbound'],
    ])
    expect(ledger.every((r) => r.ratedPeriodId === 'rp-1')).toBe(true)

    // lot burns
    const lotUpdates = updates.filter((u) => u.entity === 'WalletTransaction')
    expect(lotUpdates).toEqual([
      { entity: 'WalletTransaction', id: 'f', patch: { remainingCents: '0' } },
      { entity: 'WalletTransaction', id: 'p', patch: { remainingCents: '400' } },
    ])

    // wallet materialization + lockVersion bump
    const walletUpdate = updates.find((u) => u.entity === 'Wallet')!
    expect(walletUpdate.patch).toEqual({
      balanceCents: '400',
      freeBalanceCents: '0',
      paidBalanceCents: '400',
      lockVersion: 1,
    })
  })

  it('rejects a non-positive debit', async () => {
    const { service } = makeService({}, [])
    await expect(service.debit('org-1', 0, { source: 'usage', ratedPeriodId: null })).rejects.toThrow(/positive/)
  })
})

describe('WalletService.grant', () => {
  it('credits the free pool and writes an immutable credit_grant trail', async () => {
    const { service, inserts, updates } = makeService(
      { balanceCents: '0', freeBalanceCents: '0', paidBalanceCents: '0' },
      [],
    )

    const balances = await service.grant('org-1', 500, { reason: 'goodwill', operatorId: 'op-1', note: 'demo' })

    expect(balances).toEqual({ balanceCents: 500, freeBalanceCents: 500, paidBalanceCents: 0 })

    const tx = (inserts.find((i) => i.entity === 'WalletTransaction')!.rows as Record<string, unknown>[])[0]
    expect(tx).toMatchObject({
      pool: 'free',
      direction: 'inbound',
      amountCents: '500',
      remainingCents: '500',
      source: 'grant',
    })

    const grant = inserts.find((i) => i.entity === 'CreditGrant')!.rows as Record<string, unknown>
    expect(grant).toMatchObject({
      type: 'grant',
      pool: 'free',
      amountCents: '500',
      reason: 'goodwill',
      operatorId: 'op-1',
      walletTransactionId: 'tx-new',
    })

    expect(updates.find((u) => u.entity === 'Wallet')!.patch.lockVersion).toBe(1)
  })
})

describe('WalletService.topUp', () => {
  it('settles a carried negative balance then funds the paid pool', async () => {
    const { service, inserts } = makeService({ balanceCents: '-50', freeBalanceCents: '0', paidBalanceCents: '0' }, [])
    const balances = await service.topUp('org-1', 1000)
    expect(balances).toEqual({ balanceCents: 950, freeBalanceCents: 0, paidBalanceCents: 950 })
    const tx = (inserts.find((i) => i.entity === 'WalletTransaction')!.rows as Record<string, unknown>[])[0]
    expect(tx).toMatchObject({ pool: 'paid', amountCents: '1000', remainingCents: '950' }) // only surplus spendable
  })
})
