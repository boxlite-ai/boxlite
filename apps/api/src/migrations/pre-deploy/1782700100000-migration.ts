/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700100000 implements MigrationInterface {
  name = 'Migration1782700100000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "pricing_plan" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version" integer NOT NULL,
        "cpuRateCentsPerSec" numeric(38,18) NOT NULL,
        "memRateCentsPerSec" numeric(38,18) NOT NULL,
        "diskRateCentsPerSec" numeric(38,18) NOT NULL,
        "gpuRateCentsPerSec" numeric(38,18) NOT NULL,
        "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
        "effectiveTo" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pricing_plan_effective_interval" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
        CONSTRAINT "pricing_plan_non_negative_rates" CHECK (
          "cpuRateCentsPerSec" >= 0 AND
          "memRateCentsPerSec" >= 0 AND
          "diskRateCentsPerSec" >= 0 AND
          "gpuRateCentsPerSec" >= 0
        ),
        CONSTRAINT "pricing_plan_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE UNIQUE INDEX "pricing_plan_version_idx" ON "pricing_plan" ("version")`)
    await queryRunner.query(`CREATE INDEX "pricing_plan_effective_idx" ON "pricing_plan" ("effectiveFrom")`)
    await queryRunner.query(
      `INSERT INTO "pricing_plan" (
        "version",
        "cpuRateCentsPerSec",
        "memRateCentsPerSec",
        "diskRateCentsPerSec",
        "gpuRateCentsPerSec",
        "effectiveFrom",
        "effectiveTo"
      ) VALUES (1, 0.0014, 0.00045, 0.000003, 0, '2026-01-01T00:00:00Z', NULL)`,
    )

    await queryRunner.query(
      `CREATE TABLE "rated_period" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "usagePeriodArchiveId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "boxId" character varying NOT NULL,
        "pricingSegments" jsonb NOT NULL,
        "usageTotals" jsonb NOT NULL,
        "billedSeconds" numeric(38,3) NOT NULL,
        "preciseCents" numeric(38,18) NOT NULL,
        "ratedCents" bigint NOT NULL,
        "ratedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "rated_period_usage_archive_fk" FOREIGN KEY ("usagePeriodArchiveId")
          REFERENCES "box_usage_period_archive"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "rated_period_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "rated_period_usage_archive_idx" ON "rated_period" ("usagePeriodArchiveId")`,
    )
    await queryRunner.query(
      `CREATE INDEX "rated_period_org_rated_at_idx" ON "rated_period" ("organizationId", "ratedAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rated_period"`)
    await queryRunner.query(`DROP TABLE "pricing_plan"`)
  }
}
