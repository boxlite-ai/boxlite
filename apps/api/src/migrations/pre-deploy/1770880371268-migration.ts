/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1770880371268 implements MigrationInterface {
  name = 'Migration1770880371268'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "requestedSecurityOptions" jsonb`,
    )
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "effectiveSecurityOptions" jsonb`,
    )
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "securityPolicyResult" jsonb`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "securityPolicyResult"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "effectiveSecurityOptions"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "requestedSecurityOptions"`)
  }
}
