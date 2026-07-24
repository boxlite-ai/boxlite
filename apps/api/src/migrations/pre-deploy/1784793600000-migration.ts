/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1784793600000 implements MigrationInterface {
  name = 'Migration1784793600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeGeneration" bigint NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeAuthorized" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeUnavailable" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeEpoch" uuid`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeIncarnation" bigint NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeSequence" bigint NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "job" ADD "executionEpoch" uuid`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" ADD "computeBillableUntil" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" ADD "runtimeGeneration" bigint`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" ADD "runnerEpoch" uuid`)
    await queryRunner.query(
      `ALTER TABLE "box_usage_period_archive" ADD "computeBillableUntil" TIMESTAMP WITH TIME ZONE`,
    )
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" ADD "runtimeGeneration" bigint`)
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" ADD "runnerEpoch" uuid`)
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_compute_cap" CHECK ((cpu = 0 AND gpu = 0 AND mem = 0) OR ("computeBillableUntil" IS NOT NULL AND "runtimeGeneration" IS NOT NULL AND "runnerEpoch" IS NOT NULL))`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_compute_duration" CHECK ("computeBillableUntil" IS NULL OR ("computeBillableUntil" >= "startAt" AND ("endAt" IS NULL OR "endAt" <= "computeBillableUntil")))`,
    )
    await queryRunner.query(
      `CREATE TABLE "runner_runtime_epoch" ("runnerId" uuid NOT NULL, "runnerEpoch" uuid NOT NULL, "runnerIncarnation" bigint NOT NULL, "lastSequence" bigint NOT NULL, "activatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "retiredAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "runner_runtime_epoch_pk" PRIMARY KEY ("runnerId", "runnerEpoch"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "runner_runtime_epoch_current_idx" ON "runner_runtime_epoch" ("runnerId", "retiredAt")`,
    )
    await queryRunner.query(
      `CREATE TABLE "box_runtime_lease" ("boxId" character varying(12) NOT NULL, "runnerId" uuid NOT NULL, "runnerEpoch" uuid NOT NULL, "runtimeGeneration" bigint NOT NULL, "sequence" bigint NOT NULL, "actualState" character varying NOT NULL, "observedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "leaseExpiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "box_runtime_lease_pk" PRIMARY KEY ("boxId"))`,
    )
    await queryRunner.query(`CREATE INDEX "box_runtime_lease_expiry_idx" ON "box_runtime_lease" ("leaseExpiresAt")`)
    await queryRunner.query(`CREATE INDEX "box_runtime_lease_runner_idx" ON "box_runtime_lease" ("runnerId")`)
    await queryRunner.query(
      `CREATE TABLE "box_runtime_cleanup" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying(12) NOT NULL, "runnerId" uuid NOT NULL, "runnerEpoch" uuid NOT NULL, "runtimeGeneration" bigint NOT NULL, "jobId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "box_runtime_cleanup_target_uq" UNIQUE ("boxId", "runnerId", "runnerEpoch", "runtimeGeneration"), CONSTRAINT "box_runtime_cleanup_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_runtime_cleanup_job_idx" ON "box_runtime_cleanup" ("jobId") WHERE "jobId" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "box_runtime_cleanup_job_idx"`)
    await queryRunner.query(`DROP TABLE "box_runtime_cleanup"`)
    await queryRunner.query(`DROP INDEX "box_runtime_lease_runner_idx"`)
    await queryRunner.query(`DROP INDEX "box_runtime_lease_expiry_idx"`)
    await queryRunner.query(`DROP TABLE "box_runtime_lease"`)
    await queryRunner.query(`DROP INDEX "runner_runtime_epoch_current_idx"`)
    await queryRunner.query(`DROP TABLE "runner_runtime_epoch"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_compute_duration"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_compute_cap"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" DROP COLUMN "runnerEpoch"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" DROP COLUMN "runtimeGeneration"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" DROP COLUMN "computeBillableUntil"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP COLUMN "runnerEpoch"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP COLUMN "runtimeGeneration"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP COLUMN "computeBillableUntil"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeSequence"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeIncarnation"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeEpoch"`)
    await queryRunner.query(`ALTER TABLE "job" DROP COLUMN "executionEpoch"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeUnavailable"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeAuthorized"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeGeneration"`)
  }
}
