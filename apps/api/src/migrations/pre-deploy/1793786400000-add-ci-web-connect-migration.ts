/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCiWebConnect1793786400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ci_connect_attempt
      ADD COLUMN flow text NOT NULL DEFAULT 'device' CHECK (flow IN ('device','web')),
      ADD COLUMN oauth_state_hash text NULL,
      ADD COLUMN oauth_verifier_ciphertext text NULL`)
    await runner.query(`CREATE INDEX ci_connect_web_expiry_idx ON ci_connect_attempt(expires_at)
      WHERE oauth_verifier_ciphertext IS NOT NULL`)
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX ci_connect_web_expiry_idx`)
    await runner.query(`ALTER TABLE ci_connect_attempt
      DROP COLUMN oauth_verifier_ciphertext, DROP COLUMN oauth_state_hash, DROP COLUMN flow`)
  }
}
