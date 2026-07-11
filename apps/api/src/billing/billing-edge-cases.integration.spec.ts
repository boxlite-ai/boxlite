/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import Decimal from 'decimal.js'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { PaymentProviderEvent } from './entities/payment-provider-event.entity'
import { BillingOpsService } from './billing-ops.service'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { TopUpRecord } from './entities/top-up-record.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { FakePaymentProvider } from './payment/fake-payment.provider'
import type {
  PaymentProvider,
  PaymentReconcileInput,
  PaymentReconcileResult,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment/payment-provider'
import { PaymentService } from './payment/payment.service'
import { RatingService } from './rating/rating.service'
import { SettlementService } from './settlement.service'
import { WalletService } from './wallet.service'

const RUN_DATABASE_TESTS = process.env.BILLING_EDGE_DB_TESTS === '1'
const describeWithDatabase = RUN_DATABASE_TESTS ? describe : describe.skip
const schemaName = `billing_edge_${randomUUID().replaceAll('-', '')}`
const migratedTables = [
  'wallet',
  'wallet_transaction',
  'rated_period',
  'pricing_plan',
  'box_usage_period_archive',
  'top_up_record',
  'payment_provider_event',
] as const

class AmbiguousThenSuccessfulProvider extends FakePaymentProvider {
  readonly calls: TopUpPaymentInput[] = []

  override async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    this.calls.push(input)
    if (this.calls.length === 1) throw new Error('provider response was lost')
    return super.createManualTopUp(input)
  }
}

class TestWebhookPaymentProvider extends FakePaymentProvider {
  override async parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent> {
    void signature
    return JSON.parse(payload.toString('utf8')) as ProviderWebhookEvent
  }
}

class ReconciledProvider extends FakePaymentProvider {
  readonly payments = new Map<string, TopUpPaymentInput>()
  readonly reconcileCalls: PaymentReconcileInput[] = []

  override async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    const providerReference = `pi_reconcile_${input.topUpId}`
    this.payments.set(providerReference, input)
    return { status: 'pending', checkoutUrl: null, providerReference, receiptUrl: null }
  }

  override async reconcile(input: PaymentReconcileInput): Promise<PaymentReconcileResult> {
    this.reconcileCalls.push(input)
    const payment = this.payments.get(input.providerReference)
    if (!payment) throw new Error(`missing provider payment ${input.providerReference}`)
    return {
      status: 'resolved',
      event: {
        kind: 'top_up_paid',
        providerEventId: `reconcile:${input.providerReference}:paid`,
        providerReference: input.providerReference,
        topUpId: payment.topUpId,
        organizationId: payment.organizationId,
        amountCents: payment.amountCents,
        currency: 'usd',
        receiptUrl: 'https://receipt.test/reconciled',
      },
    }
  }
}

function connectionOptions() {
  return {
    type: 'postgres' as const,
    host: process.env.BILLING_EDGE_DB_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.BILLING_EDGE_DB_PORT ?? process.env.DB_PORT ?? '25432'),
    username: process.env.BILLING_EDGE_DB_USERNAME ?? process.env.DB_USERNAME ?? 'boxlite',
    password: process.env.BILLING_EDGE_DB_PASSWORD ?? process.env.DB_PASSWORD ?? 'boxlite',
    database: process.env.BILLING_EDGE_DB_DATABASE ?? process.env.DB_DATABASE ?? 'boxlite',
  }
}

describeWithDatabase('Billing common edge cases with PostgreSQL', () => {
  let controlDataSource: DataSource
  let billingDataSource: DataSource

  beforeAll(async () => {
    if (!/^billing_edge_[a-f0-9]+$/.test(schemaName)) {
      throw new Error(`unsafe billing edge-case schema name: ${schemaName}`)
    }

    controlDataSource = await new DataSource(connectionOptions()).initialize()
    await controlDataSource.query(`CREATE SCHEMA "${schemaName}"`)
    for (const tableName of migratedTables) {
      await controlDataSource.query(
        `CREATE TABLE "${schemaName}"."${tableName}" (LIKE public."${tableName}" INCLUDING ALL)`,
      )
    }
    billingDataSource = await new DataSource({
      ...connectionOptions(),
      schema: schemaName,
      entities: [
        Wallet,
        WalletTransaction,
        RatedPeriod,
        PricingPlan,
        BoxUsagePeriodArchive,
        TopUpRecord,
        PaymentProviderEvent,
      ],
      synchronize: false,
    }).initialize()
  }, 30_000)

  afterEach(async () => {
    await billingDataSource.getRepository(PaymentProviderEvent).clear()
    await billingDataSource.getRepository(WalletTransaction).clear()
    await billingDataSource.getRepository(TopUpRecord).clear()
    await billingDataSource.getRepository(RatedPeriod).clear()
    await billingDataSource.getRepository(BoxUsagePeriodArchive).clear()
    await billingDataSource.getRepository(PricingPlan).clear()
    await billingDataSource.getRepository(Wallet).clear()
  })

  afterAll(async () => {
    if (billingDataSource?.isInitialized) await billingDataSource.destroy()
    if (controlDataSource?.isInitialized) {
      await controlDataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      await controlDataSource.destroy()
    }
  })

  function walletService(): WalletService {
    return new WalletService(billingDataSource.getRepository(Wallet), billingDataSource.getRepository(RatedPeriod), {
      get: (key: string) => {
        if (key === 'billing.trialGrantCents') return 10_000
        if (key === 'billing.trialDurationDays') return 30
        throw new Error(`unexpected billing config key ${key}`)
      },
    } as never)
  }

  function paymentService(
    wallets: WalletService,
    provider: PaymentProvider = new FakePaymentProvider(),
  ): PaymentService {
    return new PaymentService(
      billingDataSource.getRepository(Wallet),
      billingDataSource.getRepository(TopUpRecord),
      wallets,
      provider,
      { getOrThrow: () => 'http://localhost:3000' } as never,
    )
  }

  async function createWallet(organizationId: string, overrides: Partial<Wallet> = {}): Promise<Wallet> {
    const repository = billingDataSource.getRepository(Wallet)
    return repository.save(
      repository.create({
        organizationId,
        freeBalanceCents: '0',
        paidBalanceCents: '1000',
        settlementRemainderCents: '0',
        freeExpiresAt: null,
        billingStatus: 'active',
        paymentProviderCustomerId: null,
        paymentProviderMethodId: null,
        paymentMethodBrand: null,
        paymentMethodLast4: null,
        autoReloadEnabled: false,
        autoReloadThresholdCents: null,
        autoReloadTargetCents: null,
        autoReloadNextAttemptAt: null,
        ...overrides,
      }),
    )
  }

  async function createRatedPeriod(organizationId: string, preciseCents = '300'): Promise<RatedPeriod> {
    const repository = billingDataSource.getRepository(RatedPeriod)
    return repository.save(
      repository.create({
        usagePeriodArchiveId: randomUUID(),
        organizationId,
        boxId: `edge-box-${randomUUID()}`,
        pricingSegments: [],
        usageTotals: { cpuSeconds: '60', memGibSeconds: '0', diskGibSeconds: '0', gpuSeconds: '0' },
        billedSeconds: '60',
        preciseCents,
        ratedCents: preciseCents,
        ratedAt: new Date(),
      }),
    )
  }

  it('creates exactly one immutable rating when two workers rate the same archived period', async () => {
    const archiveRepository = billingDataSource.getRepository(BoxUsagePeriodArchive)
    const planRepository = billingDataSource.getRepository(PricingPlan)
    const ratedRepository = billingDataSource.getRepository(RatedPeriod)
    const startAt = new Date('1900-01-01T00:00:00.000Z')
    const endAt = new Date('1900-01-01T00:01:00.000Z')
    const archive = await archiveRepository.save(
      archiveRepository.create({
        boxId: `edge-box-${randomUUID()}`,
        organizationId: randomUUID(),
        startAt,
        endAt,
        cpu: 1,
        mem: 0,
        disk: 0,
        gpu: 0,
        region: 'us',
      }),
    )
    const plan = await planRepository.save(
      planRepository.create({
        version: 1,
        cpuRateCentsPerSec: '0.01',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveFrom: new Date('1899-01-01T00:00:00.000Z'),
        effectiveTo: new Date('1901-01-01T00:00:00.000Z'),
      }),
    )
    const service = new RatingService(archiveRepository, ratedRepository, planRepository)

    const results = await Promise.all([service.ratePeriod(archive), service.ratePeriod(archive)])

    expect(results.filter(Boolean)).toHaveLength(1)
    plan.cpuRateCentsPerSec = '0.02'
    await planRepository.save(plan)
    const rows = await ratedRepository.findBy({ usagePeriodArchiveId: archive.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].pricingSegments[0].pricingVersion).toBe(plan.version)
    expect(new Decimal(rows[0].pricingSegments[0].unitRates.cpuRateCentsPerSec).equals('0.01')).toBe(true)
  })

  it('serializes concurrent debits so one rated period changes the wallet once', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId)
    const period = await createRatedPeriod(organizationId)
    const service = walletService()

    const results = await Promise.all([service.debitRatedPeriod(period), service.debitRatedPeriod(period)])

    expect(results.filter(Boolean)).toHaveLength(1)
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '700',
    })
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ ratedPeriodId: period.id }),
    ).resolves.toBe(1)
  })

  it('settles one archive exactly once when two complete settlement sweeps overlap', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId)
    const archiveRepository = billingDataSource.getRepository(BoxUsagePeriodArchive)
    const planRepository = billingDataSource.getRepository(PricingPlan)
    const ratedRepository = billingDataSource.getRepository(RatedPeriod)
    const startAt = new Date('1900-02-01T00:00:00.000Z')
    const archive = await archiveRepository.save(
      archiveRepository.create({
        boxId: `edge-box-${randomUUID()}`,
        organizationId,
        startAt,
        endAt: new Date('1900-02-01T00:01:00.000Z'),
        cpu: 1,
        mem: 0,
        disk: 0,
        gpu: 0,
        region: 'us',
      }),
    )
    await planRepository.save(
      planRepository.create({
        version: 2,
        cpuRateCentsPerSec: '1',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveFrom: new Date('1900-01-01T00:00:00.000Z'),
        effectiveTo: new Date('1901-01-01T00:00:00.000Z'),
      }),
    )
    const wallets = walletService()
    const settlement = new SettlementService(
      new RatingService(archiveRepository, ratedRepository, planRepository),
      wallets,
    )

    await Promise.all([settlement.settleClosedPeriods(), settlement.settleClosedPeriods()])

    await expect(ratedRepository.countBy({ usagePeriodArchiveId: archive.id })).resolves.toBe(1)
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'usage_debit' }),
    ).resolves.toBe(1)
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '940',
    })
  })

  it('keeps the final balance correct when usage debit and duplicate paid webhooks race', async () => {
    const organizationId = randomUUID()
    const wallet = await createWallet(organizationId)
    const period = await createRatedPeriod(organizationId)
    const topUpRepository = billingDataSource.getRepository(TopUpRecord)
    const topUp = await topUpRepository.save(
      topUpRepository.create({
        walletId: wallet.id,
        organizationId,
        amountCents: '500',
        source: 'manual',
        status: 'pending',
        idempotencyKey: `edge-${randomUUID()}`,
        providerReference: null,
        checkoutUrl: null,
        receiptUrl: null,
        failureCode: null,
        failureMessage: null,
        completedAt: null,
      }),
    )
    const wallets = walletService()
    const payments = paymentService(wallets, new TestWebhookPaymentProvider())
    const paidEvent = (providerEventId: string) =>
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_paid',
          providerEventId,
          providerReference: `edge-payment-${topUp.id}`,
          topUpId: topUp.id,
          organizationId,
          amountCents: topUp.amountCents,
          currency: 'usd',
          receiptUrl: 'https://receipt.test/edge',
        }),
      )
    const failedEvent = Buffer.from(
      JSON.stringify({
        kind: 'top_up_failed',
        providerEventId: `edge:${randomUUID()}`,
        providerReference: `edge-payment-${topUp.id}`,
        topUpId: topUp.id,
        organizationId,
        failureCode: 'network_timeout',
        failureMessage: 'late failure',
      }),
    )
    const firstEventId = `edge:${randomUUID()}`

    await Promise.all([
      wallets.debitRatedPeriod(period),
      payments.handleWebhook(paidEvent(firstEventId), 'test'),
      payments.handleWebhook(paidEvent(firstEventId), 'test'),
      payments.handleWebhook(paidEvent(`edge:${randomUUID()}`), 'test'),
      payments.handleWebhook(failedEvent, 'test'),
    ])

    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '1200',
    })
    await expect(billingDataSource.getRepository(WalletTransaction).findBy({ organizationId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'usage_debit', amountCents: '-300' }),
        expect.objectContaining({ kind: 'top_up', amountCents: '500' }),
      ]),
    )
    await expect(billingDataSource.getRepository(WalletTransaction).countBy({ organizationId })).resolves.toBe(2)
    await expect(billingDataSource.getRepository(PaymentProviderEvent).count()).resolves.toBe(3)
    await expect(topUpRepository.findOneByOrFail({ id: topUp.id })).resolves.toMatchObject({ status: 'paid' })
  })

  it('claims only one auto-reload when two schedulers observe the same low balance', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '900',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
      autoReloadEnabled: true,
      autoReloadThresholdCents: '1000',
      autoReloadTargetCents: '5000',
    })
    const payments = paymentService(walletService())
    const now = new Date('2026-07-10T00:00:00.000Z')

    const results = await Promise.all([
      payments.runAutoReloadForOrganization(organizationId, now),
      payments.runAutoReloadForOrganization(organizationId, now),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '5000',
    })
    await expect(
      billingDataSource.getRepository(TopUpRecord).countBy({ organizationId, source: 'auto_reload' }),
    ).resolves.toBe(1)
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'top_up' }),
    ).resolves.toBe(1)
  })

  it('retries one top-up after the provider succeeds but the first local update fails', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '0',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
    const payments = paymentService(walletService())
    const idempotencyKey = `edge-${randomUUID()}`
    await controlDataSource.query(`
      CREATE FUNCTION "${schemaName}".fail_paid_top_up_update() RETURNS trigger AS $$
      BEGIN
        IF NEW."providerReference" LIKE 'fake-payment-%' THEN
          RAISE EXCEPTION 'provider success persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_paid_top_up_update
      BEFORE UPDATE ON "${schemaName}"."top_up_record"
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".fail_paid_top_up_update();
    `)

    try {
      await expect(payments.createManualTopUp(organizationId, '2500', idempotencyKey)).rejects.toThrow(
        'provider success persistence failure',
      )
    } finally {
      await controlDataSource.query(`
        DROP TRIGGER IF EXISTS fail_paid_top_up_update ON "${schemaName}"."top_up_record";
        DROP FUNCTION IF EXISTS "${schemaName}".fail_paid_top_up_update();
      `)
    }

    await expect(
      billingDataSource.getRepository(TopUpRecord).findOneByOrFail({ organizationId, idempotencyKey }),
    ).resolves.toMatchObject({ status: 'pending' })
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '0',
    })
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'top_up' }),
    ).resolves.toBe(0)

    await expect(payments.createManualTopUp(organizationId, '2500', idempotencyKey)).resolves.toMatchObject({
      status: 'paid',
    })
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '2500',
    })
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'top_up' }),
    ).resolves.toBe(1)
  })

  it('keeps an ambiguous provider response pending and retries the same top-up id', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '0',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
    const provider = new AmbiguousThenSuccessfulProvider()
    const payments = paymentService(walletService(), provider)
    const idempotencyKey = `edge-${randomUUID()}`

    await expect(payments.createManualTopUp(organizationId, '2500', idempotencyKey)).rejects.toThrow(
      'payment provider request failed',
    )
    await expect(
      billingDataSource.getRepository(TopUpRecord).findOneByOrFail({ organizationId, idempotencyKey }),
    ).resolves.toMatchObject({ status: 'pending', failureCode: null, completedAt: null })
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '0',
    })

    await expect(payments.createManualTopUp(organizationId, '2500', idempotencyKey)).resolves.toMatchObject({
      status: 'paid',
    })
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0].topUpId).toBe(provider.calls[1].topUpId)
    await expect(billingDataSource.getRepository(TopUpRecord).countBy({ organizationId })).resolves.toBe(1)
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'top_up' }),
    ).resolves.toBe(1)
  })

  it('lets only one API instance claim and reconcile a stale pending top-up', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '0',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
    const provider = new ReconciledProvider()
    const first = paymentService(walletService(), provider)
    const second = paymentService(walletService(), provider)
    const topUp = await first.createManualTopUp(organizationId, '2500', `edge-${randomUUID()}`)
    const reconcileAt = new Date(Date.now() + 10 * 60 * 1000)

    const claims = await Promise.all([
      first.reconcileTopUp(topUp.id, reconcileAt),
      second.reconcileTopUp(topUp.id, reconcileAt),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(provider.reconcileCalls).toHaveLength(1)
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '2500',
    })
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'top_up' }),
    ).resolves.toBe(1)
  })

  it('deduplicates concurrent refund events and restores with one immutable counter-entry', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '0',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
    const payments = paymentService(walletService(), new TestWebhookPaymentProvider())
    const topUp = await payments.createManualTopUp(organizationId, '2500', `edge-${randomUUID()}`)
    await payments.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_paid',
          providerEventId: `edge:${randomUUID()}`,
          providerReference: `edge-payment-${topUp.id}`,
          topUpId: topUp.id,
          organizationId,
          amountCents: '2500',
          currency: 'usd',
          receiptUrl: null,
        }),
      ),
      'test',
    )
    const refund = (providerEventId: string, direction: 'debit' | 'restore') =>
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_adjusted',
          providerEventId,
          providerReference: 're_concurrent',
          topUpId: topUp.id,
          organizationId,
          amountCents: '500',
          currency: 'usd',
          adjustment: 'refund',
          direction,
        }),
      )

    await Promise.all([
      payments.handleWebhook(refund(`edge:${randomUUID()}`, 'debit'), 'test'),
      payments.handleWebhook(refund(`edge:${randomUUID()}`, 'debit'), 'test'),
    ])
    await payments.handleWebhook(refund(`edge:${randomUUID()}`, 'restore'), 'test')

    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '2500',
    })
    await expect(billingDataSource.getRepository(TopUpRecord).findOneByOrFail({ id: topUp.id })).resolves.toMatchObject(
      {
        refundedCents: '0',
      },
    )
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'adjustment' }),
    ).resolves.toBe(2)
  })

  it('persists a failed webhook and retries it after the business transaction rolls back', async () => {
    const organizationId = randomUUID()
    await createWallet(organizationId, {
      paidBalanceCents: '0',
      paymentProviderCustomerId: 'edge-customer',
      paymentProviderMethodId: 'edge-method',
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    })
    const payments = paymentService(walletService(), new TestWebhookPaymentProvider())
    const topUp = await payments.createManualTopUp(organizationId, '2500', `edge-${randomUUID()}`)
    await payments.handleWebhook(
      Buffer.from(
        JSON.stringify({
          kind: 'top_up_paid',
          providerEventId: `edge:${randomUUID()}`,
          providerReference: `edge-payment-${topUp.id}`,
          topUpId: topUp.id,
          organizationId,
          amountCents: '2500',
          currency: 'usd',
          receiptUrl: null,
        }),
      ),
      'test',
    )
    const failedEventId = `edge:${randomUUID()}`
    const refundEvent = Buffer.from(
      JSON.stringify({
        kind: 'top_up_adjusted',
        providerEventId: failedEventId,
        providerReference: 're_retry',
        topUpId: topUp.id,
        organizationId,
        amountCents: '500',
        currency: 'usd',
        adjustment: 'refund',
        direction: 'debit',
      }),
    )
    await controlDataSource.query(`
      CREATE FUNCTION "${schemaName}".fail_billing_adjustment() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'adjustment' THEN RAISE EXCEPTION 'adjustment write unavailable'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_billing_adjustment
      BEFORE INSERT ON "${schemaName}"."wallet_transaction"
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".fail_billing_adjustment();
    `)
    try {
      await expect(payments.handleWebhook(refundEvent, 'test')).rejects.toThrow('adjustment write unavailable')
    } finally {
      await controlDataSource.query(`
        DROP TRIGGER IF EXISTS fail_billing_adjustment ON "${schemaName}"."wallet_transaction";
        DROP FUNCTION IF EXISTS "${schemaName}".fail_billing_adjustment();
      `)
    }

    const eventRepository = billingDataSource.getRepository(PaymentProviderEvent)
    await expect(eventRepository.findOneByOrFail({ providerEventId: failedEventId })).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      payload: expect.objectContaining({ providerReference: 're_retry' }),
    })
    await eventRepository.update({ providerEventId: failedEventId }, { nextAttemptAt: new Date(0) })
    await payments.scheduledPaymentRecovery(new Date())

    await expect(eventRepository.findOneByOrFail({ providerEventId: failedEventId })).resolves.toMatchObject({
      status: 'processed',
      nextAttemptAt: null,
      lastError: null,
    })
    await expect(billingDataSource.getRepository(Wallet).findOneByOrFail({ organizationId })).resolves.toMatchObject({
      paidBalanceCents: '2000',
    })
    await expect(
      billingDataSource.getRepository(WalletTransaction).countBy({ organizationId, kind: 'adjustment' }),
    ).resolves.toBe(1)
  })

  it('identifies the exact organization, top-up, provider reference, and failed webhook in health output', async () => {
    const organizationId = randomUUID()
    const wallet = await createWallet(organizationId, { paidBalanceCents: '-250' })
    const topUp = await billingDataSource.getRepository(TopUpRecord).save(
      billingDataSource.getRepository(TopUpRecord).create({
        walletId: wallet.id,
        organizationId,
        amountCents: '500',
        source: 'manual',
        status: 'pending',
        idempotencyKey: `health:${randomUUID()}`,
        providerReference: 'pi_health_pending',
        checkoutUrl: null,
        receiptUrl: null,
        failureCode: null,
        failureMessage: null,
        reconcileAttempts: 2,
        nextReconcileAt: new Date('1900-01-01T00:00:00.000Z'),
        lastReconciledAt: new Date('1900-01-01T00:00:00.000Z'),
        reconcileLastError: 'provider timeout',
        refundedCents: '0',
        disputedCents: '0',
        completedAt: null,
        createdAt: new Date('1900-01-01T00:00:00.000Z'),
      }),
    )
    await billingDataSource.getRepository(PaymentProviderEvent).save(
      billingDataSource.getRepository(PaymentProviderEvent).create({
        providerEventId: 'evt_health_failed',
        eventType: 'top_up_paid',
        providerReference: 'pi_health_pending',
        status: 'failed',
        payload: { organizationId, topUpId: topUp.id },
        attempts: 3,
        nextAttemptAt: new Date('1900-01-01T00:00:00.000Z'),
        lastError: 'wallet transaction unavailable',
        createdAt: new Date('1900-01-01T00:00:00.000Z'),
        updatedAt: new Date('1900-01-01T00:00:00.000Z'),
      }),
    )

    const queryRunner = billingDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      const health = await new BillingOpsService({ manager: queryRunner.manager } as never).collectHealth()

      expect(health.pendingPayment).toEqual({
        topUpId: topUp.id,
        organizationId,
        providerReference: 'pi_health_pending',
        lastError: 'provider timeout',
      })
      expect(health.failedWebhook).toEqual({
        providerEventId: 'evt_health_failed',
        eventType: 'top_up_paid',
        organizationId,
        topUpId: topUp.id,
        providerReference: 'pi_health_pending',
        lastError: 'wallet transaction unavailable',
      })
      expect(health.negativeWallet).toEqual({ organizationId, balanceCents: '-250' })
    } finally {
      await queryRunner.release()
    }
  })
})
