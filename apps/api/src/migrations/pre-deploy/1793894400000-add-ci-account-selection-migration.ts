/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'
export class AddCiAccountSelection1793894400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ci_connect_attempt ADD COLUMN oauth_token_ciphertext text NULL,
      DROP CONSTRAINT ci_connect_attempt_state_check,
      ADD CONSTRAINT ci_connect_attempt_state_check CHECK
      (state IN ('pending','polling','selecting','done','failed','cancelled','expired','installation_required'))`)
    await runner.query(`CREATE INDEX ci_connect_selection_expiry_idx ON ci_connect_attempt(expires_at)
      WHERE oauth_token_ciphertext IS NOT NULL`)
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      `UPDATE ci_connect_attempt SET state='failed',oauth_token_ciphertext=NULL WHERE state='selecting'`,
    )
    await runner.query(`DROP INDEX ci_connect_selection_expiry_idx`)
    await runner.query(`ALTER TABLE ci_connect_attempt DROP COLUMN oauth_token_ciphertext,
      DROP CONSTRAINT ci_connect_attempt_state_check,
      ADD CONSTRAINT ci_connect_attempt_state_check CHECK
      (state IN ('pending','polling','done','failed','cancelled','expired','installation_required'))`)
  }
}
