/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1783910300000 implements MigrationInterface {
  name = 'Migration1783910300000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "btree_gist"`)
    await queryRunner.query(`CREATE TABLE "subscription_plan" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "code" character varying NOT NULL,
      "rank" integer NOT NULL,
      "monthlyPriceCents" bigint NOT NULL,
      "quotaCents" bigint NOT NULL,
      "overageCpuMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "overageMemMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "overageDiskMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "overageGpuMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "active" boolean NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "subscription_plan_non_negative_money" CHECK ("monthlyPriceCents" >= 0 AND "quotaCents" >= 0),
      CONSTRAINT "subscription_plan_positive_overage_multipliers" CHECK (
        "overageCpuMultiplier" >= 1 AND "overageMemMultiplier" >= 1 AND
        "overageDiskMultiplier" >= 1 AND "overageGpuMultiplier" >= 1
      ),
      CONSTRAINT "subscription_plan_id_pk" PRIMARY KEY ("id")
    )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "subscription_plan_code_idx" ON "subscription_plan" ("code")`)
    await queryRunner.query(`CREATE UNIQUE INDEX "subscription_plan_rank_idx" ON "subscription_plan" ("rank")`)
    await queryRunner.query(`INSERT INTO "subscription_plan"
      ("code", "rank", "monthlyPriceCents", "quotaCents") VALUES
      ('starter', 1, 1900, 3000),
      ('pro', 2, 14900, 25000),
      ('max', 3, 49900, 90000)`)

    await queryRunner.query(`CREATE TABLE "organization_subscription" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "organizationId" uuid NOT NULL,
      "planId" uuid NOT NULL,
      "status" character varying NOT NULL DEFAULT 'pending',
      "providerSubscriptionId" character varying,
      "providerScheduleId" character varying,
      "currentPeriodStart" TIMESTAMP WITH TIME ZONE,
      "currentPeriodEnd" TIMESTAMP WITH TIME ZONE,
      "pendingPlanId" uuid,
      "pendingChangeKind" character varying,
      "pendingChangeIdempotencyKey" character varying,
      "pendingPlanEffectiveAt" TIMESTAMP WITH TIME ZONE,
      "checkoutProviderReference" character varying,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "organization_subscription_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT,
      CONSTRAINT "organization_subscription_plan_fk" FOREIGN KEY ("planId") REFERENCES "subscription_plan"("id") ON DELETE RESTRICT,
      CONSTRAINT "organization_subscription_pending_plan_fk" FOREIGN KEY ("pendingPlanId") REFERENCES "subscription_plan"("id") ON DELETE RESTRICT,
      CONSTRAINT "organization_subscription_id_pk" PRIMARY KEY ("id")
    )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "organization_subscription_org_idx" ON "organization_subscription" ("organizationId")`)
    await queryRunner.query(`CREATE UNIQUE INDEX "organization_subscription_provider_idx" ON "organization_subscription" ("providerSubscriptionId") WHERE "providerSubscriptionId" IS NOT NULL`)

    await queryRunner.query(`CREATE TABLE "subscription_period" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "subscriptionId" uuid NOT NULL,
      "organizationId" uuid NOT NULL,
      "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
      "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
      "quotaGrantedPreciseCents" numeric(38,18) NOT NULL,
      "quotaConsumedPreciseCents" numeric(38,18) NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "subscription_period_valid_interval" CHECK ("periodEnd" > "periodStart"),
      CONSTRAINT "subscription_period_valid_quota" CHECK (
        "quotaGrantedPreciseCents" >= 0 AND "quotaConsumedPreciseCents" >= 0 AND
        "quotaConsumedPreciseCents" <= "quotaGrantedPreciseCents"
      ),
      CONSTRAINT "subscription_period_subscription_fk" FOREIGN KEY ("subscriptionId") REFERENCES "organization_subscription"("id") ON DELETE RESTRICT,
      CONSTRAINT "subscription_period_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT,
      CONSTRAINT "subscription_period_org_no_overlap" EXCLUDE USING gist (
        "organizationId" WITH =, (tstzrange("periodStart", "periodEnd", '[)')) WITH &&
      ),
      CONSTRAINT "subscription_period_id_pk" PRIMARY KEY ("id")
    )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "subscription_period_subscription_start_idx" ON "subscription_period" ("subscriptionId", "periodStart")`)
    await queryRunner.query(`CREATE INDEX "subscription_period_org_interval_idx" ON "subscription_period" ("organizationId", "periodStart", "periodEnd")`)

    await queryRunner.query(`CREATE TABLE "subscription_entitlement" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "subscriptionPeriodId" uuid NOT NULL,
      "organizationId" uuid NOT NULL,
      "planCode" character varying NOT NULL,
      "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
      "effectiveTo" TIMESTAMP WITH TIME ZONE,
      "overageCpuMultiplier" numeric(20,9) NOT NULL,
      "overageMemMultiplier" numeric(20,9) NOT NULL,
      "overageDiskMultiplier" numeric(20,9) NOT NULL,
      "overageGpuMultiplier" numeric(20,9) NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "subscription_entitlement_valid_interval" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
      CONSTRAINT "subscription_entitlement_positive_overage_multipliers" CHECK (
        "overageCpuMultiplier" >= 1 AND "overageMemMultiplier" >= 1 AND
        "overageDiskMultiplier" >= 1 AND "overageGpuMultiplier" >= 1
      ),
      CONSTRAINT "subscription_entitlement_period_fk" FOREIGN KEY ("subscriptionPeriodId") REFERENCES "subscription_period"("id") ON DELETE RESTRICT,
      CONSTRAINT "subscription_entitlement_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT,
      CONSTRAINT "subscription_entitlement_period_no_overlap" EXCLUDE USING gist (
        "subscriptionPeriodId" WITH =,
        (tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz), '[)')) WITH &&
      ),
      CONSTRAINT "subscription_entitlement_id_pk" PRIMARY KEY ("id")
    )`)
    await queryRunner.query(`CREATE INDEX "subscription_entitlement_period_effective_idx" ON "subscription_entitlement" ("subscriptionPeriodId", "effectiveFrom")`)
    await queryRunner.query(`CREATE INDEX "subscription_entitlement_org_effective_idx" ON "subscription_entitlement" ("organizationId", "effectiveFrom", "effectiveTo")`)

    await queryRunner.query(`CREATE TABLE "user_resource_multiplier" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "organizationId" uuid NOT NULL,
      "userId" character varying NOT NULL,
      "cpuMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "memMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "diskMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "gpuMultiplier" numeric(20,9) NOT NULL DEFAULT 1,
      "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
      "effectiveTo" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "user_resource_multiplier_valid_interval" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
      CONSTRAINT "user_resource_multiplier_non_negative" CHECK (
        "cpuMultiplier" >= 0 AND "memMultiplier" >= 0 AND
        "diskMultiplier" >= 0 AND "gpuMultiplier" >= 0
      ),
      CONSTRAINT "user_resource_multiplier_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT,
      CONSTRAINT "user_resource_multiplier_no_overlap" EXCLUDE USING gist (
        "organizationId" WITH =, "userId" WITH =,
        (tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz), '[)')) WITH &&
      ),
      CONSTRAINT "user_resource_multiplier_id_pk" PRIMARY KEY ("id")
    )`)
    await queryRunner.query(`CREATE INDEX "user_resource_multiplier_effective_idx" ON "user_resource_multiplier" ("organizationId", "userId", "effectiveFrom")`)
    await queryRunner.query(`CREATE UNIQUE INDEX "user_resource_multiplier_current_idx" ON "user_resource_multiplier" ("organizationId", "userId") WHERE "effectiveTo" IS NULL`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_resource_multiplier"`)
    await queryRunner.query(`DROP TABLE "subscription_entitlement"`)
    await queryRunner.query(`DROP TABLE "subscription_period"`)
    await queryRunner.query(`DROP TABLE "organization_subscription"`)
    await queryRunner.query(`DROP TABLE "subscription_plan"`)
  }
}
