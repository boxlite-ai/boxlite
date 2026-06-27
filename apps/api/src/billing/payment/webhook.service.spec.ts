/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, QueryFailedError } from 'typeorm'
import { WalletService } from '../wallet/wallet.service'
import { PaymentProvider, VerifiedWebhookEvent } from './payment-provider.interface'
import { WebhookService } from './webhook.service'

/** A DataSource whose processed_stripe_event "table" enforces PK uniqueness in-memory. */
function makeDataSource(seen: Set<string>) {
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
    update: async () => undefined,
  }
  return {
    transaction: async (cb: (m: typeof manager) => unknown) => cb(manager),
  } as unknown as DataSource
}

function topupEvent(eventId: string): VerifiedWebhookEvent {
  return { eventId, type: 'topup.succeeded', organizationId: 'org-1', amountCents: 1000, providerRef: 'cs_1' }
}

function makeService(event: VerifiedWebhookEvent) {
  const seen = new Set<string>()
  const topUpWithin = jest.fn(async () => ({ balanceCents: 1000, freeBalanceCents: 0, paidBalanceCents: 1000 }))
  const wallet = { topUpWithin } as unknown as WalletService
  const provider = { parseWebhook: () => event } as unknown as PaymentProvider
  return { service: new WebhookService(makeDataSource(seen), wallet, provider), topUpWithin }
}

describe('WebhookService.ingest idempotency', () => {
  it('credits the wallet on first delivery', async () => {
    const { service, topUpWithin } = makeService(topupEvent('evt_1'))
    expect(await service.ingest(Buffer.from('{}'), 'sig')).toBe('processed')
    expect(topUpWithin).toHaveBeenCalledTimes(1)
    expect(topUpWithin).toHaveBeenCalledWith(expect.anything(), 'org-1', 1000, 'manual', 'evt_1')
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
})
