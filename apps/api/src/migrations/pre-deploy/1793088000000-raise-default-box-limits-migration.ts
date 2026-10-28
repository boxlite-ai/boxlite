/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class RaiseDefaultBoxLimits1793088000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organization"
        ALTER COLUMN "max_cpu_per_box" SET DEFAULT 16,
        ALTER COLUMN "max_memory_per_box" SET DEFAULT 32,
        ALTER COLUMN "max_disk_per_box" SET DEFAULT 100
    `)
    // Match the complete historical default so a partially customized quota stays intact.
    await queryRunner.query(`
      UPDATE "organization"
      SET "max_cpu_per_box" = 16, "max_memory_per_box" = 32, "max_disk_per_box" = 100
      WHERE "max_cpu_per_box" = 4 AND "max_memory_per_box" = 8 AND "max_disk_per_box" = 10
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Existing values may have been customized since upgrade; do not lower them.
    await queryRunner.query(`
      ALTER TABLE "organization"
        ALTER COLUMN "max_cpu_per_box" SET DEFAULT 4,
        ALTER COLUMN "max_memory_per_box" SET DEFAULT 8,
        ALTER COLUMN "max_disk_per_box" SET DEFAULT 10
    `)
  }
}
