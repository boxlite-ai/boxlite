/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMemoryCheckpoints1793600000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TYPE "public"."box_state_enum" ADD VALUE IF NOT EXISTS 'paused'`)
    await runner.query(`ALTER TYPE "public"."box_desiredstate_enum" ADD VALUE IF NOT EXISTS 'paused'`)
    await runner.query(`ALTER TABLE "runner" ADD "checkpointsEnabled" boolean NOT NULL DEFAULT false`)
    await runner.query(`ALTER TABLE "box" ADD "initialCheckpointId" uuid, ADD "checkpointOperationId" uuid`)
    await runner.query(`CREATE INDEX "box_initial_checkpoint_idx" ON "box" ("initialCheckpointId")`)
    await runner.query(`CREATE TABLE "box_checkpoint" (
      "id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL, "name" varchar NOT NULL,
      "sourceBoxId" varchar NOT NULL, "region" varchar NOT NULL, "state" varchar NOT NULL DEFAULT 'creating',
      "archiveUri" varchar NOT NULL DEFAULT '', "visible" boolean NOT NULL DEFAULT true,
      "nativeCheckpointId" uuid, "nativeRunnerId" uuid, "bootDiskSha256" varchar, "contentSha256" varchar,
      "configuration" jsonb NOT NULL, "cpus" integer NOT NULL, "memoryMib" integer NOT NULL, "diskGb" integer NOT NULL,
      "sizeBytes" bigint NOT NULL DEFAULT 0, "errorReason" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`)
    await runner.query(
      `CREATE UNIQUE INDEX "box_checkpoint_org_name_unique" ON "box_checkpoint" ("organizationId", "name") WHERE "state" <> 'deleting'`,
    )
    await runner.query(`CREATE INDEX "box_checkpoint_source_idx" ON "box_checkpoint" ("organizationId", "sourceBoxId")`)
    await runner.query(`CREATE INDEX "box_checkpoint_state_idx" ON "box_checkpoint" ("state")`)
    await runner.query(`CREATE TABLE "box_checkpoint_operation" (
      "id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL, "boxId" varchar NOT NULL, "checkpointId" uuid,
      "jobId" uuid NOT NULL, "kind" varchar NOT NULL, "state" varchar NOT NULL DEFAULT 'pending',
      "error" jsonb, "createdAt" timestamptz NOT NULL DEFAULT now())`)
    await runner.query(
      `CREATE UNIQUE INDEX "box_checkpoint_operation_job_unique" ON "box_checkpoint_operation" ("jobId")`,
    )
    await runner.query(`CREATE INDEX "box_checkpoint_operation_state_idx" ON "box_checkpoint_operation" ("state")`)
    await runner.query(
      `CREATE INDEX "box_checkpoint_operation_resource_idx" ON "box_checkpoint_operation" ("checkpointId", "state")`,
    )
    await runner.query(`CREATE TABLE "box_checkpoint_transfer" (
      "id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL, "runnerId" uuid NOT NULL, "kind" varchar NOT NULL,
      "state" varchar NOT NULL DEFAULT 'staging', "inspection" jsonb, "nativeCheckpointId" uuid,
      "checkpointId" uuid, "targetBoxId" varchar, "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now())`)
    await runner.query(`CREATE INDEX "box_checkpoint_transfer_expiry_idx" ON "box_checkpoint_transfer" ("expiresAt")`)
  }

  async down(runner: QueryRunner): Promise<void> {
    const [active] = await runner.query(
      `SELECT EXISTS(SELECT 1 FROM "box" WHERE "state"::text = 'paused' OR "desiredState"::text = 'paused' OR "initialCheckpointId" IS NOT NULL OR "checkpointOperationId" IS NOT NULL) AS active`,
    )
    if (active.active) throw new Error('Resume/stop paused boxes and finish checkpoint operations before rollback')
    await runner.query('DROP TABLE "box_checkpoint_transfer", "box_checkpoint_operation", "box_checkpoint"')
    await runner.query('ALTER TABLE "box" DROP COLUMN "initialCheckpointId", DROP COLUMN "checkpointOperationId"')
    await runner.query('ALTER TABLE "runner" DROP COLUMN "checkpointsEnabled"')
    // As with snapshot states, PostgreSQL enum additions remain after downgrade.
  }
}
