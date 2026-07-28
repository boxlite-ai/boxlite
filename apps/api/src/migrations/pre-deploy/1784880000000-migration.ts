/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Runtime authority: who owns a Box's runtime, and until when.
 *
 * Consolidated from #1061, which grew this schema across three migrations
 * written weeks apart (1784707200000 and 1784793600000, plus columns folded
 * into its billing migrations). None of those ever ran anywhere, so this
 * rebuilds the final shape in one step rather than replaying a history that
 * never happened.
 */
export class Migration1784880000000 implements MigrationInterface {
  name = 'Migration1784880000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // One row per runner process lifetime. `runnerIncarnation` increments on
    // every runner restart; `lastSequence` is the highest command number that
    // incarnation issued.
    await queryRunner.query(
      `CREATE TABLE "runner_runtime_epoch" (` +
        `"runnerId" uuid NOT NULL, ` +
        `"runnerEpoch" uuid NOT NULL, ` +
        `"runnerIncarnation" bigint NOT NULL, ` +
        `"lastSequence" bigint NOT NULL, ` +
        `"activatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, ` +
        `"retiredAt" TIMESTAMP WITH TIME ZONE, ` +
        `CONSTRAINT "runner_runtime_epoch_pk" PRIMARY KEY ("runnerId", "runnerEpoch"))`,
    )

    // One row per Box, naming the runner epoch and runtime generation that is
    // currently authoritative for it, and when that claim lapses.
    await queryRunner.query(
      `CREATE TABLE "box_runtime_lease" (` +
        `"boxId" character varying(12) NOT NULL, ` +
        `"runnerId" uuid NOT NULL, ` +
        `"runnerEpoch" uuid NOT NULL, ` +
        `"runtimeGeneration" bigint NOT NULL, ` +
        `"sequence" bigint NOT NULL, ` +
        `"actualState" character varying NOT NULL, ` +
        `"observedAt" TIMESTAMP WITH TIME ZONE NOT NULL, ` +
        `"leaseExpiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, ` +
        `"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "box_runtime_lease_pk" PRIMARY KEY ("boxId"))`,
    )

    // Work queue for runtimes that outlived their lease. The unique constraint
    // is what makes cleanup idempotent: the same (box, runner, epoch,
    // generation) target can only be claimed once.
    await queryRunner.query(
      `CREATE TABLE "box_runtime_cleanup" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"boxId" character varying(12) NOT NULL, ` +
        `"runnerId" uuid NOT NULL, ` +
        `"runnerEpoch" uuid NOT NULL, ` +
        `"runtimeGeneration" bigint NOT NULL, ` +
        `"jobId" uuid, ` +
        `"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "box_runtime_cleanup_target_uq" UNIQUE ("boxId", "runnerId", "runnerEpoch", "runtimeGeneration"), ` +
        `CONSTRAINT "box_runtime_cleanup_pk" PRIMARY KEY ("id"))`,
    )

    // The runner's side of the same identity: which epoch it is currently
    // serving, how many times its process has restarted, and the last command
    // number it issued.
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeEpoch" uuid`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeIncarnation" bigint NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "runtimeSequence" bigint NOT NULL DEFAULT '0'`)

    // Which runner epoch a job was dispatched under, so a result arriving
    // from a superseded epoch can be recognised and dropped.
    await queryRunner.query(`ALTER TABLE "job" ADD "executionEpoch" uuid`)

    await queryRunner.query(`ALTER TABLE "box" ADD "lifecycleJobId" uuid`)
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeGeneration" bigint NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeAuthorized" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "runtimeUnavailable" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(
      `CREATE INDEX "box_lifecycle_job_idx" ON "box" ("lifecycleJobId") WHERE "lifecycleJobId" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "box_lifecycle_job_idx"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeUnavailable"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeAuthorized"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runtimeGeneration"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "lifecycleJobId"`)
    await queryRunner.query(`ALTER TABLE "job" DROP COLUMN "executionEpoch"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeSequence"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeIncarnation"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "runtimeEpoch"`)
    await queryRunner.query(`DROP TABLE "box_runtime_cleanup"`)
    await queryRunner.query(`DROP TABLE "box_runtime_lease"`)
    await queryRunner.query(`DROP TABLE "runner_runtime_epoch"`)
  }
}
