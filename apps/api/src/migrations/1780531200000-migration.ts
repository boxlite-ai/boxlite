/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1780531200000 implements MigrationInterface {
  name = 'Migration1780531200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "autoArchiveInterval"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "autoArchiveInterval" integer NOT NULL DEFAULT '10080'`,
    )
  }
}
