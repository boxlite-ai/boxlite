/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, QueryFailedError } from 'typeorm'
import { TopUpRecord } from '../entities/top-up-record.entity'
import { WalletService } from '../wallet/wallet.service'
import { PaymentProvider, VerifiedWebhookEvent } from './payment-provider.interface'
import { WebhookService } from './webhook.service'

/** A DataSource whose processed_stripe_event "table" enforces PK uniqueness in-memory. */
function makeDataSource(
  seen: Set<string>,
  topUpRecord: Partial<TopUpRecord> | null = {
    id: 'topup-1',
    organizationId: 'org-1',
    amountCents: '1000',
    status: 'pending',
    stripeSessionId: 'cs_1',
  },
) {
  const updates: { entity: string; patch: unknown }[] = []
  const manager = {
    insert: async (entity: { name: string }, row: { stripeEventId?: string }) => {
      if (entity.name === 'ProcessedStripeEvent') {
        if (seen.has(row.stripeEventId!)) {
          throw new QueryFailedError('insert', [], { code: '23505' } as unknown as Error) // duplicate PK
        }
        seen.add(row.stripeEventId!)
      }
      return { identifiers: [{ id: 'x' }] }
    },
    findOne: async (entity: { name: string }, opts?: { where?: Record<string, unknown> }) => {
      if (entity.name === 'TopUpRecord') {
        if (
          topUpRecord &&
          topUpRecord.status === 'pending' &&
          topUpRecord.stripeSessionId === opts?.where?.stripeSessionId
        ) {
          return topUpRecord
        }
        return null
      }
      return { id: 'tx-fake' }
    },
    update: async (entity: { name: string }, _where: unknown, patch: Record<string, unknown>) => {
      updates.push({ entity: entity.name, patch })
      if (entity.name === 'TopUpRecord' && topUpRecord) {
        Object.assign(topUpRecord, patch)
      }
      return { affected: entity.name === 'TopUpRecord' && topUpRecord ? 1 : 0 }
    },
  }
  const dataSource = {
    transaction: async (cb: (m: typeof manager) => unknown) => cb(manager),
  } as unknown as DataSource
  return { dataSource, updates }
}

function topupEvent(eventId: string): VerifiedWebhookEvent {
  return { eventId, type: 'topup.succeeded', organizationId: 'org-1', amountCents: 1000, providerRef: 'cs_1' }
}

function makeService(event: VerifiedWebhookEvent) {
  const seen = new Set<string>()
  const { dataSource, updates } = makeDataSource(seen)
  const topUpWithin = jest.fn(async () => ({ balanceCents: 1000, freeBalanceCents: 0, paidBalanceCents: 1000 }))
  const getOrCreateWallet = jest.fn(async () => ({ id: 'w1', organizationId: 'org-1' }))
  const wallet = { topUpWithin, getOrCreateWallet } as unknown as WalletService
  const provider = { parseWebhook: () => event } as unknown as PaymentProvider
  return { service: new WebhookService(dataSource, wallet, provider), topUpWithin, getOrCreateWallet, updates }
}

function makeSequenceService(events: VerifiedWebhookEvent[], topUpRecord?: Partial<TopUpRecord> | null) {
  const seen = new Set<string>()
  const { dataSource, updates } = makeDataSource(seen, topUpRecord)
  const topUpWithin = jest.fn(async () => ({ balanceCents: 1000, freeBalanceCents: 0, paidBalanceCents: 1000 }))
  const wallet = { topUpWithin, getOrCreateWallet: jest.fn() } as unknown as WalletService
  let i = 0
  const provider = { parseWebhook: () => events[i++] } as unknown as PaymentProvider
  return { service: new WebhookService(dataSource, wallet, provider), topUpWithin, updates }
}

describe('WebhookService.ingest idempotency', () => {
  it('credits the wallet and settles the pending top-up record on first delivery', async () => {
    const { service, topUpWithin, updates } = makeService(topupEvent('evt_1'))
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(topUpWithin).toHaveBeenCalledTimes(1)
    expect(topUpWithin).toHaveBeenCalledWith(expect.anything(), 'org-1', 1000, 'manual', 'evt_1')
    // the pending top_up_record flips to paid and links its ledger row (no longer stuck pending)
    expect(updates).toContainEqual({ entity: 'TopUpRecord', patch: { status: 'paid', walletTransactionId: 'tx-fake' } })
  })

  it('uses the pending top-up record as the source of truth for org and amount', async () => {
    const { service, topUpWithin } = makeSequenceService(
      [
        {
          eventId: 'evt_1',
          type: 'topup.succeeded',
          organizationId: 'attacker-org',
          amountCents: 999_999,
          providerRef: 'cs_1',
        },
      ],
      {
        id: 'topup-1',
        organizationId: 'org-from-db',
        amountCents: '1000',
        status: 'pending',
        stripeSessionId: 'cs_1',
      },
    )

    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(topUpWithin).toHaveBeenCalledWith(expect.anything(), 'org-from-db', 1000, 'manual', 'evt_1')
  })

  it('does not credit again for a different event id resolving the same checkout session', async () => {
    const { service, topUpWithin } = makeSequenceService([topupEvent('evt_1'), topupEvent('evt_2')])

    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(topUpWithin).toHaveBeenCalledTimes(1)
  })

  it('does NOT credit again when the same event id is re-delivered (the marker guard)', async () => {
    const { service, topUpWithin } = makeService(topupEvent('evt_1'))
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    // re-deliver the identical event — marker insert hits the unique PK, txn rolls back
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('duplicate')
    expect(topUpWithin).toHaveBeenCalledTimes(1) // still once — no double credit
  })

  it('ignores event types with no wallet effect', async () => {
    const { service, topUpWithin } = makeService({
      eventId: 'evt_x',
      type: 'ignored',
      organizationId: null,
      amountCents: null,
      providerRef: null,
    })
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('ignored')
    expect(topUpWithin).not.toHaveBeenCalled()
  })

  it('marks the top-up record failed (no credit) on a failed event', async () => {
    const { service, topUpWithin, updates } = makeService({
      eventId: 'evt_f',
      type: 'topup.failed',
      organizationId: 'org-1',
      amountCents: 1000,
      providerRef: 'cs_1',
    })
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(topUpWithin).not.toHaveBeenCalled()
    expect(updates).toContainEqual({ entity: 'TopUpRecord', patch: { status: 'failed', walletTransactionId: null } })
  })

  it('ensures the wallet row exists before flagging a saved card (no silent drop)', async () => {
    const { service, getOrCreateWallet, updates } = makeService({
      eventId: 'evt_m',
      type: 'method.saved',
      organizationId: 'org-1',
      amountCents: null,
      providerRef: null,
    })
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(getOrCreateWallet).toHaveBeenCalledWith('org-1') // lazy-create before the UPDATE
    expect(updates).toContainEqual({ entity: 'Wallet', patch: { creditCardConnected: true } })
  })
})
