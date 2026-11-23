/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCancellationFeedback1795449600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE organization ADD COLUMN "cancellationFeedback" jsonb NULL')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE organization DROP COLUMN "cancellationFeedback"')
  }
}
