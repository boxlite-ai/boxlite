/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxSnapshotTables1791200000001 implements MigrationInterface {
  name = 'AddBoxSnapshotTables1791200000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."box_snapshot_state_enum" AS ENUM('creating', 'ready', 'failed', 'deleting')`,
    )
    // No foreign key to `box`: a snapshot belongs to the organization and
    // outlives the box it was taken from.
    await queryRunner.query(
      `CREATE TABLE "box_snapshot" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid NOT NULL, "name" character varying NOT NULL, "sourceBoxId" character varying(12) NOT NULL, "region" character varying NOT NULL, "diskGb" integer NOT NULL, "state" "public"."box_snapshot_state_enum" NOT NULL DEFAULT 'creating', "archiveUri" character varying NOT NULL DEFAULT '', "jobId" uuid, "sizeBytes" bigint NOT NULL DEFAULT '0', "errorReason" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "box_snapshot_id_pk" PRIMARY KEY ("id"))`,
    )
    // A deleting snapshot gives its name back at once; its row only waits for
    // the reaper to remove the archive.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_snapshot_organization_name_unique" ON "box_snapshot" ("organizationId", "name") WHERE "state" <> 'deleting'`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_snapshot_source_box_idx" ON "box_snapshot" ("organizationId", "sourceBoxId")`,
    )
    await queryRunner.query(`CREATE INDEX "box_snapshot_state_idx" ON "box_snapshot" ("state")`)
    await queryRunner.query(`CREATE INDEX "box_snapshot_job_idx" ON "box_snapshot" ("jobId")`)

    await queryRunner.query(
      `CREATE TYPE "public"."box_snapshot_restore_state_enum" AS ENUM('pending', 'succeeded', 'failed')`,
    )
    await queryRunner.query(
      `CREATE TABLE "box_snapshot_restore" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid NOT NULL, "boxId" character varying(12) NOT NULL, "snapshotId" uuid NOT NULL, "state" "public"."box_snapshot_restore_state_enum" NOT NULL DEFAULT 'pending', "jobId" uuid, "errorReason" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "box_snapshot_restore_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_snapshot_restore_snapshot_idx" ON "box_snapshot_restore" ("snapshotId", "state")`,
    )
    await queryRunner.query(`CREATE INDEX "box_snapshot_restore_box_idx" ON "box_snapshot_restore" ("boxId")`)
    await queryRunner.query(`CREATE INDEX "box_snapshot_restore_state_idx" ON "box_snapshot_restore" ("state")`)
    await queryRunner.query(`CREATE INDEX "box_snapshot_restore_job_idx" ON "box_snapshot_restore" ("jobId")`)
    await queryRunner.query(
      `ALTER TABLE "box_snapshot_restore" ADD CONSTRAINT "box_snapshot_restore_box_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_snapshot_restore" ADD CONSTRAINT "box_snapshot_restore_snapshot_fk" FOREIGN KEY ("snapshotId") REFERENCES "box_snapshot"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_snapshot_restore"`)
    await queryRunner.query(`DROP TYPE "public"."box_snapshot_restore_state_enum"`)
    await queryRunner.query(`DROP TABLE "box_snapshot"`)
    await queryRunner.query(`DROP TYPE "public"."box_snapshot_state_enum"`)
  }
}
