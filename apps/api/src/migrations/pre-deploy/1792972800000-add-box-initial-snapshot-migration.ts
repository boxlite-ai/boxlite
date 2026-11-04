/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxInitialSnapshot1792972800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "initialSnapshotId" uuid')
    await queryRunner.query('CREATE INDEX "box_initial_snapshot_idx" ON "box" ("initialSnapshotId")')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "box_initial_snapshot_idx"')
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "initialSnapshotId"')
  }
}
