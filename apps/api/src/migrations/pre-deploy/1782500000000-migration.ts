import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782500000000 implements MigrationInterface {
  name = 'Migration1782500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── pricing_plan ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "pricing_plan" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version" integer NOT NULL,
        "cpuRateCentsPerSec" numeric(30,10) NOT NULL,
        "memRateCentsPerSec" numeric(30,10) NOT NULL,
        "diskRateCentsPerSec" numeric(30,10) NOT NULL,
        "warnThresholdCents" bigint NOT NULL,
        "defaultGrantCents" bigint NOT NULL,
        "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
        "effectiveTo" TIMESTAMP WITH TIME ZONE,
        "createdBy" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pricing_plan_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE UNIQUE INDEX "pricing_plan_version_idx" ON "pricing_plan" ("version")`)
    await queryRunner.query(`CREATE INDEX "pricing_plan_effective_idx" ON "pricing_plan" ("effectiveFrom")`)

    // ─── customer_rate_override ───────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "customer_rate_override" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" character varying NOT NULL,
        "discountFactor" numeric(6,5),
        "effectiveRates" jsonb,
        "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
        "effectiveTo" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "customer_rate_override_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "rate_override_discount_range" CHECK ("discountFactor" IS NULL OR ("discountFactor" >= 0 AND "discountFactor" <= 1))
      )`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "rate_override_org_active_idx" ON "customer_rate_override" ("organizationId") WHERE "effectiveTo" IS NULL`,
    )

    // ─── rated_period ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "rated_period" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "usagePeriodId" uuid NOT NULL,
        "organizationId" character varying NOT NULL,
        "boxId" character varying NOT NULL,
        "pricingVersion" integer NOT NULL,
        "unitRates" jsonb NOT NULL,
        "billedSeconds" numeric(30,5) NOT NULL,
        "preciseCents" numeric(30,5) NOT NULL,
        "ratedCents" bigint NOT NULL,
        "ratedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "rated_period_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE UNIQUE INDEX "rated_period_usage_period_idx" ON "rated_period" ("usagePeriodId")`)
    await queryRunner.query(
      `CREATE INDEX "rated_period_org_rated_at_idx" ON "rated_period" ("organizationId", "ratedAt")`,
    )

    // ─── wallet ───────────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "wallet" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" character varying NOT NULL,
        "balanceCents" bigint NOT NULL DEFAULT '0',
        "ongoingBalanceCents" bigint NOT NULL DEFAULT '0',
        "freeBalanceCents" bigint NOT NULL DEFAULT '0',
        "paidBalanceCents" bigint NOT NULL DEFAULT '0',
        "freeExpiresAt" TIMESTAMP WITH TIME ZONE,
        "billingStatus" character varying NOT NULL DEFAULT 'trial',
        "frozen" boolean NOT NULL DEFAULT false,
        "lockVersion" integer NOT NULL DEFAULT 0,
        "autoTopupThresholdCents" bigint,
        "autoTopupTargetCents" bigint,
        "creditCardConnected" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "wallet_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "wallet_free_non_negative" CHECK ("freeBalanceCents" >= 0),
        CONSTRAINT "wallet_paid_non_negative" CHECK ("paidBalanceCents" >= 0)
      )`,
    )
    await queryRunner.query(`CREATE UNIQUE INDEX "wallet_org_idx" ON "wallet" ("organizationId")`)

    // ─── wallet_transaction ───────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "wallet_transaction" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" uuid NOT NULL,
        "pool" character varying NOT NULL,
        "priority" integer NOT NULL,
        "direction" character varying NOT NULL,
        "amountCents" bigint NOT NULL,
        "remainingCents" bigint,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "status" character varying NOT NULL DEFAULT 'settled',
        "source" character varying NOT NULL,
        "ratedPeriodId" uuid,
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "stripeRef" text,
        "providerEventId" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "wallet_transaction_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "wallet_tx_remaining_non_negative" CHECK ("remainingCents" IS NULL OR "remainingCents" >= 0)
      )`,
    )
    await queryRunner.query(`CREATE INDEX "wallet_tx_wallet_idx" ON "wallet_transaction" ("walletId", "createdAt")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallet_tx_provider_event_idx" ON "wallet_transaction" ("providerEventId") WHERE "providerEventId" IS NOT NULL`,
    )

    // ─── credit_grant ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "credit_grant" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" character varying NOT NULL,
        "amountCents" bigint NOT NULL,
        "type" character varying NOT NULL,
        "pool" character varying NOT NULL,
        "reason" character varying NOT NULL,
        "note" text,
        "operatorId" character varying NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "walletTransactionId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "credit_grant_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "credit_grant_org_idx" ON "credit_grant" ("organizationId", "createdAt")`)

    // ─── processed_stripe_event ───────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "processed_stripe_event" (
        "stripeEventId" text NOT NULL,
        "eventType" text NOT NULL,
        "processedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "processed_stripe_event_pk" PRIMARY KEY ("stripeEventId")
      )`,
    )

    // ─── top_up_record ────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "top_up_record" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" character varying NOT NULL,
        "amountCents" bigint NOT NULL,
        "method" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "walletTransactionId" uuid,
        "stripeSessionId" text,
        "stripePaymentIntentId" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "top_up_record_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "top_up_org_idx" ON "top_up_record" ("organizationId", "createdAt")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "top_up_record"`)
    await queryRunner.query(`DROP TABLE "processed_stripe_event"`)
    await queryRunner.query(`DROP TABLE "credit_grant"`)
    await queryRunner.query(`DROP TABLE "wallet_transaction"`)
    await queryRunner.query(`DROP TABLE "wallet"`)
    await queryRunner.query(`DROP TABLE "rated_period"`)
    await queryRunner.query(`DROP TABLE "customer_rate_override"`)
    await queryRunner.query(`DROP TABLE "pricing_plan"`)
  }
}
