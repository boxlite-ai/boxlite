/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'
export class AddCiWebTarget1794000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE ci_connect_attempt ADD COLUMN web_target_ciphertext text NULL')
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      "UPDATE ci_connect_attempt SET state='failed',oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE web_target_ciphertext IS NOT NULL",
    )
    await runner.query('ALTER TABLE ci_connect_attempt DROP COLUMN web_target_ciphertext')
  }
}
