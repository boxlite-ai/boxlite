import { MigrationInterface, QueryRunner } from 'typeorm'
import { assertCompleteOutboundDrained } from '../complete-outbound-schema'

export class AddCompleteOutboundEnrollmentAndClaims1795096803000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE complete_outbound_runner_enrollment (
      runner_id uuid PRIMARY KEY REFERENCES "runner" (id) ON DELETE CASCADE,
      lease_id uuid NOT NULL UNIQUE,
      token_sha256 varchar(64) NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      runner_key_sha256 varchar(64) NOT NULL CHECK (runner_key_sha256 ~ '^[0-9a-f]{64}$'),
      verified_floor text NOT NULL,
      expires_at timestamptz NOT NULL
    )`)
    await runner.query('ALTER TABLE "job" ADD "completeOutboundReconciling" boolean NOT NULL DEFAULT false')
  }

  async down(runner: QueryRunner): Promise<void> {
    await assertCompleteOutboundDrained(runner, false)
    await runner.query('ALTER TABLE "job" DROP COLUMN "completeOutboundReconciling"')
    await runner.query('DROP TABLE complete_outbound_runner_enrollment')
  }
}
