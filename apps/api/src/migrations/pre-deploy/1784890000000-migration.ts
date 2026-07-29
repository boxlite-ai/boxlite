/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Usage periods: how long a Box was billable and in what mode.
 *
 * Consolidated from #1061, which created these tables in 1782700000000 and
 * then added the runtime-generation columns, the compute constraints and the
 * organization indexes across two later migrations. None ran anywhere, so
 * this builds the final shape directly.
 *
 * The `compute_cap` check is the load-bearing one: a period may only carry
 * non-zero cpu/gpu/mem if it names the runtime generation that justified it.
 * Compute is billable only when something can be shown to have been running.
 */
export class Migration1784890000000 implements MigrationInterface {
  name = 'Migration1784890000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "box_usage_period" ( "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying NOT NULL, "organizationId" character varying NOT NULL, "startAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endAt" TIMESTAMP WITH TIME ZONE, "cpu" double precision NOT NULL, "gpu" double precision NOT NULL, "mem" double precision NOT NULL, "disk" double precision NOT NULL, "region" character varying NOT NULL, "boxClass" character varying NOT NULL DEFAULT 'small', "regionType" character varying NOT NULL DEFAULT 'shared', "computeBillableUntil" TIMESTAMP WITH TIME ZONE, "runtimeGeneration" bigint, "runnerEpoch" uuid, CONSTRAINT "box_usage_period_id_pk" PRIMARY KEY ("id") )`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_usage_period_box_end_idx" ON "box_usage_period" ("boxId", "endAt")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_usage_period_one_open_per_box_idx" ON "box_usage_period" ("boxId") WHERE "endAt" IS NULL`,
    )
    await queryRunner.query(
      `CREATE TABLE "box_usage_period_archive" ( "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying NOT NULL, "organizationId" character varying NOT NULL, "startAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endAt" TIMESTAMP WITH TIME ZONE NOT NULL, "cpu" double precision NOT NULL, "gpu" double precision NOT NULL, "mem" double precision NOT NULL, "disk" double precision NOT NULL, "region" character varying NOT NULL, "boxClass" character varying NOT NULL DEFAULT 'small', "regionType" character varying NOT NULL DEFAULT 'shared', "computeBillableUntil" TIMESTAMP WITH TIME ZONE, "runtimeGeneration" bigint, "runnerEpoch" uuid, CONSTRAINT "box_usage_period_archive_id_pk" PRIMARY KEY ("id") )`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_compute_cap" CHECK ((cpu = 0 AND gpu = 0 AND mem = 0) OR ("computeBillableUntil" IS NOT NULL AND "runtimeGeneration" IS NOT NULL AND "runnerEpoch" IS NOT NULL))`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_compute_duration" CHECK ("computeBillableUntil" IS NULL OR ("computeBillableUntil" >= "startAt" AND ("endAt" IS NULL OR "endAt" <= "computeBillableUntil")))`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_usage_period_organization_end_idx" ON "box_usage_period" ("organizationId", "endAt")`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_usage_period_archive_organization_end_idx" ON "box_usage_period_archive" ("organizationId", "endAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "box_usage_period_archive_organization_end_idx"`,
    )
    await queryRunner.query(
      `DROP INDEX "box_usage_period_organization_end_idx"`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_compute_duration"`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_compute_cap"`,
    )
    await queryRunner.query(
      `DROP TABLE "box_usage_period_archive"`,
    )
    await queryRunner.query(
      `DROP INDEX "box_usage_period_one_open_per_box_idx"`,
    )
    await queryRunner.query(
      `DROP INDEX "box_usage_period_box_end_idx"`,
    )
    await queryRunner.query(
      `DROP TABLE "box_usage_period"`,
    )
  }
}
