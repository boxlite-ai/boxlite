/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { PaymentProviderEvent } from '../entities/payment-provider-event.entity'
import { TopUpRecord } from '../entities/top-up-record.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
import { Wallet } from '../entities/wallet.entity'
import { FakePaymentProvider } from './fake-payment.provider'
import {
  PaymentProvider,
  PaymentReconcileInput,
  PaymentReconcileResult,
  PaymentSetupInput,
  PaymentSetupResult,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment-provider'
import { PaymentService } from './payment.service'

const ORG_ID = 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0'

class FakeRepository<T extends { id?: string }> {
  readonly rows: T[] = []
  readonly saveErrors: Error[] = []
  manager: FakeEntityManager

  constructor(private readonly prefix: string) {}

  create(input: Partial<T>): T {
    return input as T
  }

  async save(row: T): Promise<T> {
    const saveError = this.saveErrors.shift()
    if (saveError) throw saveError
    row.id ??= `${this.prefix}-${this.rows.length + 1}`
    const index = this.rows.findIndex((candidate) => candidate.id === row.id)
    if (index === -1) this.rows.push(row)
    else this.rows[index] = row
    return row
  }

  async findOne(options: { where: Partial<T> }): Promise<T | null> {
    return (
      this.rows.find((row) =>
        Object.entries(options.where).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
      ) ?? null
    )
  }
}

class FakeEntityManager {
  constructor(private readonly repositories: Map<unknown, FakeRepository<never>>) {}

  transaction<T>(callback: (manager: FakeEntityManager) => Promise<T>): Promise<T> {
    return callback(this)
  }

  getRepository<T extends { id?: string }>(entity: unknown): FakeRepository<T> {
    const repository = this.repositories.get(entity)
    if (!repository) throw new Error(`missing fake repository for ${String(entity)}`)
    return repository as unknown as FakeRepository<T>
  }
}

class PendingPaymentProvider extends FakePaymentProvider {
  override async createManualTopUp(): Promise<TopUpPaymentResult> {
    return {
      status: 'pending',
      checkoutUrl: 'https://checkout.test/pending',
      providerReference: 'checkout-pending',
      receiptUrl: null,
    }
  }
}

class TestWebhookPaymentProvider extends PendingPaymentProvider {
  override async parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent> {
    void signature
    return JSON.parse(payload.toString('utf8')) as ProviderWebhookEvent
  }
}

class HookedSuccessfulPaymentProvider extends FakePaymentProvider {
  manualTopUpCalls = 0
  beforeManualTopUpResult?: () => void

  override async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    this.manualTopUpCalls++
    this.beforeManualTopUpResult?.()
    return super.createManualTopUp(input)
  }
}

class AmbiguousThenSuccessfulPaymentProvider extends FakePaymentProvider {
  manualTopUpCalls: TopUpPaymentInput[] = []

  override async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    this.manualTopUpCalls.push(input)
    if (this.manualTopUpCalls.length === 1) throw new Error('provider response was lost')
    return super.createManualTopUp(input)
  }
}

class AmbiguousThenSuccessfulSetupProvider extends FakePaymentProvider {
  setupCalls: PaymentSetupInput[] = []

  override async createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult> {
    this.setupCalls.push(input)
    if (this.setupCalls.length === 1) throw new Error('setup provider response was lost')
    return super.createSetup(input)
  }
}

class ReconciledPaymentProvider extends PendingPaymentProvider {
  reconcileCalls: PaymentReconcileInput[] = []

  override async reconcile(input: PaymentReconcileInput): Promise<PaymentReconcileResult> {
    this.reconcileCalls.push(input)
    return {
      status: 'resolved',
      event: {
        kind: 'top_up_paid',
        providerEventId: `reconcile:${input.providerReference}:paid`,
        providerReference: input.providerReference,
        topUpId: 'top-up-1',
        organizationId: ORG_ID,
        amountCents: '2500',
        currency: 'usd',
        receiptUrl: 'https://receipt.test/reconciled',
      },
    }
  }
}

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-1',
    organizationId: ORG_ID,
    freeBalanceCents: '0',
    paidBalanceCents: '0',
    settlementRemainderCents: '0',
    freeExpiresAt: null,
    billingStatus: 'zero_balance',
    paymentProviderCustomerId: null,
    paymentProviderMethodId: null,
    paymentMethodBrand: null,
    paymentMethodLast4: null,
    paymentSetupAttemptId: null,
    paymentSetupProviderReference: null,
    paymentSetupNextReconcileAt: null,
    paymentSetupReconcileAttempts: 0,
    paymentSetupLastError: null,
    autoReloadEnabled: false,
    autoReloadThresholdCents: null,
    autoReloadTargetCents: null,
    autoReloadNextAttemptAt: null,
    createdAt: new Date('2026-07-10T00:00:00Z'),
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    ...overrides,
  }
}

function createService(provider: PaymentProvider = new FakePaymentProvider(), walletOverrides: Partial<Wallet> = {}) {
  const wallets = new FakeRepository<Wallet>('wallet')
  const topUps = new FakeRepository<TopUpRecord>('top-up')
  const events = new FakeRepository<PaymentProviderEvent>('event')
  const transactions = new FakeRepository<WalletTransaction>('transaction')
  const currentWallet = wallet(walletOverrides)
  wallets.rows.push(currentWallet)

  const repositories = new Map<unknown, FakeRepository<never>>([
    [Wallet, wallets as unknown as FakeRepository<never>],
    [TopUpRecord, topUps as unknown as FakeRepository<never>],
    [PaymentProviderEvent, events as unknown as FakeRepository<never>],
    [WalletTransaction, transactions as unknown as FakeRepository<never>],
  ])
  const manager = new FakeEntityManager(repositories)
  wallets.manager = manager
  topUps.manager = manager
  events.manager = manager
  transactions.manager = manager

  const service = new PaymentService(
    wallets as never,
    topUps as never,
    { getOrCreateWallet: jest.fn().mockResolvedValue(currentWallet) } as never,
    provider,
    { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') } as never,
  )
  return { service, currentWallet, wallets, topUps, events, transactions }
}

describe('PaymentService', () => {
  it('attaches the fake provider card for local E2E', async () => {
    const { service, currentWallet } = createService()

    await expect(service.setupPaymentMethod(ORG_ID)).resolves.toEqual({ status: 'ready', checkoutUrl: null })
    expect(currentWallet).toMatchObject({
      paymentProviderCustomerId: 'fake-customer-wallet-1',
      paymentProviderMethodId: 'fake-card-wallet-1',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
  })

  it('credits paid balance and writes one immutable ledger row for an idempotent top-up', async () => {
    const { service, currentWallet, topUps, transactions } = createService(new FakePaymentProvider(), {
      paidBalanceCents: '-500',
      paymentProviderCustomerId: 'fake-customer-wallet-1',
      paymentProviderMethodId: 'fake-card-wallet-1',
    })

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-1')).resolves.toMatchObject({ status: 'paid' })
    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-1')).resolves.toMatchObject({ status: 'paid' })
    await expect(service.createManualTopUp(ORG_ID, '5000', 'request-1')).rejects.toThrow(
      'idempotency key was already used with a different amount',
    )

    expect(currentWallet).toMatchObject({ paidBalanceCents: '2000', billingStatus: 'active' })
    expect(topUps.rows).toHaveLength(1)
    expect(transactions.rows).toEqual([
      expect.objectContaining({ kind: 'top_up', amountCents: '2500', source: 'manual_top_up' }),
    ])
  })

  it('resumes an idempotent top-up left pending before its provider result was committed', async () => {
    const { service, currentWallet, topUps } = createService(new FakePaymentProvider(), {
      paymentProviderCustomerId: 'fake-customer-wallet-1',
      paymentProviderMethodId: 'fake-card-wallet-1',
    })
    topUps.rows.push({
      id: 'top-up-crash',
      walletId: currentWallet.id,
      organizationId: ORG_ID,
      amountCents: '2500',
      source: 'manual',
      status: 'pending',
      idempotencyKey: 'request-crash',
      providerReference: 'fake-payment-top-up-crash',
      checkoutUrl: null,
      receiptUrl: null,
      failureCode: null,
      failureMessage: null,
      reconcileAttempts: 0,
      nextReconcileAt: null,
      lastReconciledAt: null,
      reconcileLastError: null,
      refundedCents: '0',
      disputedCents: '0',
      completedAt: null,
      createdAt: new Date('2026-07-10T00:00:00Z'),
      updatedAt: new Date('2026-07-10T00:00:00Z'),
    })

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-crash')).resolves.toMatchObject({
      id: 'top-up-crash',
      status: 'paid',
    })
    expect(currentWallet.paidBalanceCents).toBe('2500')
  })

  it('keeps a successful provider result retryable when local persistence fails', async () => {
    const provider = new HookedSuccessfulPaymentProvider()
    const { service, currentWallet, topUps, transactions } = createService(provider, {
      paymentProviderCustomerId: 'fake-customer-wallet-1',
      paymentProviderMethodId: 'fake-card-wallet-1',
    })
    provider.beforeManualTopUpResult = () => {
      provider.beforeManualTopUpResult = undefined
      topUps.saveErrors.push(new Error('database unavailable after provider success'))
    }

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-persistence')).rejects.toThrow(
      'database unavailable after provider success',
    )
    expect(topUps.rows[0].status).toBe('pending')
    expect(currentWallet.paidBalanceCents).toBe('0')
    expect(transactions.rows).toHaveLength(0)

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-persistence')).resolves.toMatchObject({
      status: 'paid',
    })
    expect(provider.manualTopUpCalls).toBe(2)
    expect(currentWallet.paidBalanceCents).toBe('2500')
    expect(transactions.rows).toHaveLength(1)
  })

  it('keeps an ambiguous provider error pending and retries the same top-up', async () => {
    const provider = new AmbiguousThenSuccessfulPaymentProvider()
    const { service, currentWallet, topUps, transactions } = createService(provider, {
      paymentProviderCustomerId: 'fake-customer-wallet-1',
      paymentProviderMethodId: 'fake-card-wallet-1',
    })

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-ambiguous')).rejects.toThrow(
      'payment provider request failed',
    )
    expect(topUps.rows[0]).toMatchObject({ status: 'pending', failureCode: null, completedAt: null })
    expect(currentWallet.paidBalanceCents).toBe('0')
    expect(transactions.rows).toHaveLength(0)

    await expect(service.createManualTopUp(ORG_ID, '2500', 'request-ambiguous')).resolves.toMatchObject({
      status: 'paid',
    })
    expect(provider.manualTopUpCalls).toHaveLength(2)
    expect(provider.manualTopUpCalls[0].topUpId).toBe(provider.manualTopUpCalls[1].topUpId)
    expect(currentWallet.paidBalanceCents).toBe('2500')
    expect(transactions.rows).toHaveLength(1)
  })

  it('reuses one durable setup attempt after the provider response is lost', async () => {
    const provider = new AmbiguousThenSuccessfulSetupProvider()
    const { service, currentWallet } = createService(provider)

    await expect(service.setupPaymentMethod(ORG_ID)).rejects.toThrow('payment provider request failed')
    const setupAttemptId = currentWallet.paymentSetupAttemptId
    expect(setupAttemptId).toEqual(expect.any(String))
    expect(currentWallet.paymentSetupNextReconcileAt).toBeInstanceOf(Date)

    await expect(service.setupPaymentMethod(ORG_ID)).resolves.toEqual({ status: 'ready', checkoutUrl: null })
    expect(provider.setupCalls.map((call) => call.setupAttemptId)).toEqual([setupAttemptId, setupAttemptId])
    expect(currentWallet.paymentSetupAttemptId).toBeNull()
  })

  it('reconciles one pending top-up and credits the wallet exactly once', async () => {
    const provider = new ReconciledPaymentProvider()
    const { service, currentWallet, topUps, transactions } = createService(provider, {
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
    })
    const topUp = await service.createManualTopUp(ORG_ID, '2500', 'request-reconcile')
    const reconcileAt = new Date(Date.now() + 10 * 60 * 1000)

    await expect(service.reconcileTopUp(topUp.id, reconcileAt)).resolves.toBe(true)
    await expect(service.reconcileTopUp(topUp.id, new Date(reconcileAt.getTime() + 60_000))).resolves.toBe(false)

    expect(provider.reconcileCalls).toEqual([{ operation: 'top_up', providerReference: 'checkout-pending' }])
    expect(topUps.rows[0]).toMatchObject({
      status: 'paid',
      reconcileAttempts: 1,
      nextReconcileAt: null,
      reconcileLastError: null,
    })
    expect(currentWallet.paidBalanceCents).toBe('2500')
    expect(transactions.rows.filter((row) => row.kind === 'top_up')).toHaveLength(1)
  })

  it('uses immutable adjustments for refund debit and restoration without double-changing balance', async () => {
    const { service, currentWallet, topUps, transactions } = createService(new TestWebhookPaymentProvider(), {
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
    })
    const topUp = await service.createManualTopUp(ORG_ID, '2500', 'request-refund')
    await service.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_paid',
          providerEventId: 'evt-paid-for-refund',
          providerReference: 'checkout-pending',
          topUpId: topUp.id,
          organizationId: ORG_ID,
          amountCents: '2500',
          currency: 'usd',
          receiptUrl: null,
        }),
      ),
      'test',
    )

    const refundDebit = {
      kind: 'top_up_adjusted',
      providerEventId: 'evt-refund-created',
      providerReference: 're_1',
      topUpId: topUp.id,
      organizationId: ORG_ID,
      amountCents: '500',
      currency: 'usd',
      adjustment: 'refund',
      direction: 'debit',
    }
    await service.handleWebhook(Buffer.from(JSON.stringify(refundDebit)), 'test')
    await service.handleWebhook(
      Buffer.from(JSON.stringify({ ...refundDebit, providerEventId: 'evt-refund-updated' })),
      'test',
    )
    await service.handleWebhook(
      Buffer.from(
        JSON.stringify({
          ...refundDebit,
          providerEventId: 'evt-refund-failed',
          direction: 'restore',
        }),
      ),
      'test',
    )

    expect(currentWallet.paidBalanceCents).toBe('2500')
    expect(topUps.rows[0]).toMatchObject({ refundedCents: '0' })
    expect(transactions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerActionId: 'refund:re_1:debit', amountCents: '-500' }),
        expect.objectContaining({ providerActionId: 'refund:re_1:restore', amountCents: '500' }),
      ]),
    )
    expect(transactions.rows.filter((row) => row.kind === 'adjustment')).toHaveLength(2)
  })

  it('does not debit a refund when its terminal failure arrives first', async () => {
    const { service, currentWallet, transactions } = createService(new TestWebhookPaymentProvider(), {
      paidBalanceCents: '2500',
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
    })
    const topUp = await service.createManualTopUp(ORG_ID, '2500', 'request-refund-out-of-order')
    await service.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_paid',
          providerEventId: 'evt-paid-before-out-of-order-refund',
          providerReference: 'checkout-pending',
          topUpId: topUp.id,
          organizationId: ORG_ID,
          amountCents: '2500',
          currency: 'usd',
          receiptUrl: null,
        }),
      ),
      'test',
    )

    const event = {
      kind: 'top_up_adjusted',
      providerReference: 're_out_of_order',
      topUpId: topUp.id,
      organizationId: ORG_ID,
      amountCents: '500',
      currency: 'usd',
      adjustment: 'refund',
    }
    await service.handleWebhook(
      Buffer.from(JSON.stringify({ ...event, providerEventId: 'evt-failed-first', direction: 'restore' })),
      'test',
    )
    await service.handleWebhook(
      Buffer.from(JSON.stringify({ ...event, providerEventId: 'evt-created-late', direction: 'debit' })),
      'test',
    )

    expect(currentWallet.paidBalanceCents).toBe('5000')
    expect(transactions.rows.filter((row) => row.kind === 'adjustment')).toEqual([
      expect.objectContaining({ providerActionId: 'refund:re_out_of_order:restore', amountCents: '0' }),
    ])
  })

  it('converges failed then paid webhooks, ignores later failure, and never double-credits', async () => {
    const { service, currentWallet, topUps, transactions } = createService(new TestWebhookPaymentProvider(), {
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
    })
    const topUp = await service.createManualTopUp(ORG_ID, '2500', 'request-1')

    await service.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_failed',
          providerEventId: 'evt-failed',
          providerReference: 'pi-1',
          topUpId: topUp.id,
          organizationId: ORG_ID,
          failureCode: 'card_declined',
          failureMessage: 'declined',
        }),
      ),
      'test',
    )
    expect(topUps.rows[0].status).toBe('failed')

    const paidEvent = {
      kind: 'top_up_paid',
      providerEventId: 'evt-paid',
      providerReference: 'pi-1',
      topUpId: topUp.id,
      organizationId: ORG_ID,
      amountCents: '2500',
      currency: 'usd',
      receiptUrl: 'https://receipt.test/1',
    }
    await service.handleWebhook(Buffer.from(JSON.stringify(paidEvent)), 'test')
    await service.handleWebhook(Buffer.from(JSON.stringify(paidEvent)), 'test')
    await service.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_failed',
          providerEventId: 'evt-late-failure',
          providerReference: 'pi-1',
          topUpId: topUp.id,
          organizationId: ORG_ID,
          failureCode: 'late',
          failureMessage: 'late',
        }),
      ),
      'test',
    )

    expect(topUps.rows[0]).toMatchObject({ status: 'paid', receiptUrl: 'https://receipt.test/1' })
    expect(currentWallet.paidBalanceCents).toBe('2500')
    expect(transactions.rows).toHaveLength(1)
  })

  it('rejects a provider amount mismatch without crediting the wallet', async () => {
    const { service, currentWallet } = createService(new TestWebhookPaymentProvider(), {
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
    })
    const topUp = await service.createManualTopUp(ORG_ID, '2500', 'request-1')

    await expect(
      service.handleWebhook(
        Buffer.from(
          JSON.stringify({
            kind: 'top_up_paid',
            providerEventId: 'evt-wrong-amount',
            providerReference: 'pi-1',
            topUpId: topUp.id,
            organizationId: ORG_ID,
            amountCents: '2600',
            currency: 'usd',
            receiptUrl: null,
          }),
        ),
        'test',
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(currentWallet.paidBalanceCents).toBe('0')
  })

  it('tops up to the configured target once when auto-reload crosses its threshold', async () => {
    const { service, currentWallet, topUps } = createService(new FakePaymentProvider(), {
      paidBalanceCents: '900',
      billingStatus: 'active',
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
      autoReloadEnabled: true,
      autoReloadThresholdCents: '1000',
      autoReloadTargetCents: '5000',
    })

    await expect(service.runAutoReloadForOrganization(ORG_ID)).resolves.toBe(true)
    await expect(service.runAutoReloadForOrganization(ORG_ID)).resolves.toBe(false)

    expect(currentWallet.paidBalanceCents).toBe('5000')
    expect(topUps.rows).toEqual([
      expect.objectContaining({ source: 'auto_reload', amountCents: '4100', status: 'paid' }),
    ])
  })

  it('waits until the balance is below the auto-reload threshold', async () => {
    const { service, topUps } = createService(new FakePaymentProvider(), {
      paidBalanceCents: '1000',
      billingStatus: 'active',
      paymentProviderCustomerId: 'cus-1',
      paymentProviderMethodId: 'pm-1',
      autoReloadEnabled: true,
      autoReloadThresholdCents: '1000',
      autoReloadTargetCents: '5000',
    })

    await expect(service.runAutoReloadForOrganization(ORG_ID)).resolves.toBe(false)
    expect(topUps.rows).toHaveLength(0)
  })

  it('requires an attached payment method and a $10 auto-reload spread', async () => {
    const { service, currentWallet } = createService()

    await expect(
      service.setAutoReload(ORG_ID, { enabled: true, thresholdCents: '2000', targetCents: '2500' }),
    ).rejects.toBeInstanceOf(BadRequestException)

    currentWallet.paymentProviderCustomerId = 'cus-1'
    currentWallet.paymentProviderMethodId = 'pm-1'
    await expect(
      service.setAutoReload(ORG_ID, { enabled: true, thresholdCents: '2000', targetCents: '2500' }),
    ).rejects.toThrow('at least $10')
    await expect(
      service.setAutoReload(ORG_ID, { enabled: true, thresholdCents: '2000', targetCents: '5000' }),
    ).resolves.toBeUndefined()
    expect(currentWallet).toMatchObject({
      autoReloadEnabled: true,
      autoReloadThresholdCents: '2000',
      autoReloadTargetCents: '5000',
    })
  })
})
