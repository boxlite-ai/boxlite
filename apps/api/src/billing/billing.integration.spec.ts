/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Real-Postgres integration test for Phase 2 billing. Skipped by default (no DB
 * in CI); run against the local docker billing-pg with:
 *
 *   RUN_DB_IT=1 npx nx test api --testPathPatterns=billing.integration --skip-nx-cache
 *
 * It runs the Phase-2 migration, then exercises rating + wallet + webhook against
 * the live schema so the DB-level guarantees (CHECK, UNIQUE idempotency,
 * pessimistic-locked debit) are verified, not just the pure logic.
 */

import { DataSource, QueryFailedError } from 'typeorm'
import { UsagePeriod } from '../usage/entities/usage-period.entity'
import { CreditGrant } from './entities/credit-grant.entity'
import { CustomerRateOverride } from './entities/customer-rate-override.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { ProcessedStripeEvent } from './entities/processed-stripe-event.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { TopUpRecord } from './entities/top-up-record.entity'
import { Wallet } from './entities/wallet.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Migration1782500000000 } from '../migrations/pre-deploy/1782500000000-migration'
import { FakePaymentProvider } from './payment/fake-payment-provider'
import { WebhookService } from './payment/webhook.service'
import { RatingService } from './rating/rating.service'
import { WalletService } from './wallet/wallet.service'

const dbDescribe = process.env.RUN_DB_IT ? describe : describe.skip

const PHASE2_TABLES = [
  'top_up_record',
  'processed_stripe_event',
  'credit_grant',
  'wallet_transaction',
  'wallet',
  'rated_period',
  'customer_rate_override',
  'pricing_plan',
]

dbDescribe('Phase 2 billing — real Postgres', () => {
  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5433),
      username: process.env.DB_USERNAME ?? 'daytona',
      password: process.env.DB_PASSWORD ?? 'daytona',
      database: process.env.DB_DATABASE ?? 'daytona',
      entities: [
        PricingPlan,
        CustomerRateOverride,
        RatedPeriod,
        Wallet,
        WalletTransaction,
        CreditGrant,
        ProcessedStripeEvent,
        TopUpRecord,
        UsagePeriod,
      ],
      synchronize: false,
    })
    await ds.initialize()

    const qr = ds.createQueryRunner()
    // Clean slate for the Phase-2 tables, then run the migration under test.
    for (const t of PHASE2_TABLES) await qr.query(`DROP TABLE IF EXISTS "${t}" CASCADE`)
    await new Migration1782500000000().up(qr)
    // usage_period (Phase 1) is the rating input; ensure it exists for a self-contained run.
    await qr.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await qr.query(`CREATE TABLE IF NOT EXISTS "usage_period" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "boxId" varchar NOT NULL, "organizationId" varchar NOT NULL, "region" varchar,
      "periodStart" timestamptz NOT NULL, "periodEnd" timestamptz,
      "kind" varchar NOT NULL, "allocCpu" int NOT NULL, "allocMemGib" int NOT NULL, "allocDiskGib" int NOT NULL,
      "actualCpuSeconds" double precision, "actualRssAvgBytes" bigint, "actualRssPeakBytes" bigint,
      "sampleCount" int, "sealed" boolean DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "usage_period_id_pk2" PRIMARY KEY ("id"))`)
    await qr.query(`DELETE FROM "usage_period" WHERE "organizationId" = 'it-org'`)
    await qr.release()
  }, 60000)

  afterAll(async () => {
    if (!ds?.isInitialized) return
    const qr = ds.createQueryRunner()
    for (const t of PHASE2_TABLES) await qr.query(`DROP TABLE IF EXISTS "${t}" CASCADE`)
    await qr.query(`DELETE FROM "usage_period" WHERE "organizationId" = 'it-org'`)
    await qr.release()
    await ds.destroy()
  })

  it('enforces the wallet CHECK constraints (free/paid >= 0)', async () => {
    const wallet = await ds.getRepository(Wallet).save({ organizationId: 'it-chk', freeBalanceCents: '0' })
    await expect(ds.getRepository(Wallet).update(wallet.id, { freeBalanceCents: '-1' })).rejects.toBeInstanceOf(
      QueryFailedError,
    )
  })

  it('rates a closed usage period exactly once (UNIQUE idempotency)', async () => {
    await ds.getRepository(PricingPlan).save({
      version: 1,
      cpuRateCentsPerSec: '2',
      memRateCentsPerSec: '1',
      diskRateCentsPerSec: '0.5',
      warnThresholdCents: '500',
      defaultGrantCents: '0',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: null,
    })
    // 60s running, alloc 2cpu/4ram/10disk → 60×(4+4+5) = 780 cents
    await ds.query(
      `INSERT INTO "usage_period" ("boxId","organizationId","periodStart","periodEnd","kind","allocCpu","allocMemGib","allocDiskGib")
       VALUES ('box-it','it-org','2026-06-27T00:00:00Z','2026-06-27T00:01:00Z','running',2,4,10)`,
    )

    const rating = new RatingService(
      ds.getRepository(UsagePeriod),
      ds.getRepository(RatedPeriod),
      ds.getRepository(PricingPlan),
      ds.getRepository(CustomerRateOverride),
    )

    const first = await rating.rateClosedPeriods()
    expect(first.rated).toBe(1)
    const rated = await ds.getRepository(RatedPeriod).findOneByOrFail({ organizationId: 'it-org' })
    expect(rated.ratedCents).toBe('780')
    expect(rated.pricingVersion).toBe(1)

    // re-run the sweep — the UNIQUE(usagePeriodId) makes it a no-op, no double bill
    const second = await rating.rateClosedPeriods()
    expect(second.rated).toBe(0)
    expect(await ds.getRepository(RatedPeriod).countBy({ organizationId: 'it-org' })).toBe(1)
  })

  it('runs the dual-pool wallet end to end (grant → debit → overage)', async () => {
    const wallet = new WalletService(ds)
    await wallet.grant('it-wallet', 300, { reason: 'trial', operatorId: 'system' }) // free pool 300
    await wallet.topUp('it-wallet', 500) // paid pool 500 → balance 800

    const afterDebit = await wallet.debit('it-wallet', 400, { source: 'usage', ratedPeriodId: null })
    expect(afterDebit).toEqual({ balanceCents: 400, freeBalanceCents: 0, paidBalanceCents: 400 })

    // overdraw both pools → bounded negative, CHECK keeps pools at 0
    const afterOverage = await wallet.debit('it-wallet', 1000, { source: 'usage', ratedPeriodId: null })
    expect(afterOverage.balanceCents).toBe(-600)
    expect(afterOverage.freeBalanceCents).toBe(0)
    expect(afterOverage.paidBalanceCents).toBe(0)

    // ledger sums to the balance
    const rows = await ds.getRepository(WalletTransaction).find({ where: {} })
    const w = await ds.getRepository(Wallet).findOneByOrFail({ organizationId: 'it-wallet' })
    const sum = rows
      .filter((r) => r.walletId === w.id)
      .reduce((s, r) => s + (r.direction === 'inbound' ? Number(r.amountCents) : -Number(r.amountCents)), 0)
    expect(sum).toBe(Number(w.balanceCents))
  })

  it('settles a webhook top-up exactly once (processed_stripe_event idempotency)', async () => {
    const wallet = new WalletService(ds)
    const webhooks = new WebhookService(ds, wallet, new FakePaymentProvider())
    const event = Buffer.from(
      JSON.stringify({
        eventId: 'evt_it_1',
        type: 'topup.succeeded',
        organizationId: 'it-hook',
        amountCents: 1000,
        providerRef: 'cs_it',
      }),
    )

    expect(await webhooks.ingest(event, 'sig')).toBe('processed')
    expect(await webhooks.ingest(event, 'sig')).toBe('duplicate') // re-delivery
    const w = await ds.getRepository(Wallet).findOneByOrFail({ organizationId: 'it-hook' })
    expect(Number(w.balanceCents)).toBe(1000) // credited once, not twice
  })
})
