import { MigrationInterface, QueryRunner } from 'typeorm'

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
    await runner.query('LOCK TABLE complete_outbound_admission IN ACCESS EXCLUSIVE MODE')
    const [admission] = await runner.query(
      'SELECT phase, minimum_release FROM complete_outbound_admission WHERE id = 1',
    )
    if (
      !admission ||
      (admission.phase !== 'downgrading' && (admission.phase !== 'closed' || admission.minimum_release !== null))
    ) {
      throw new Error('Complete outbound release controller must close and drain admission before downgrade')
    }
    await runner.query('LOCK TABLE "box", "job", complete_outbound_runner_enrollment IN ACCESS EXCLUSIVE MODE')
    const [state] = await runner.query(`SELECT
      EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL) AS protected,
      EXISTS (SELECT 1 FROM "job" WHERE type = 'CREATE_COMPLETE_OUTBOUND_BOX' AND "completedAt" IS NULL) AS pending,
      EXISTS (SELECT 1 FROM complete_outbound_runner_enrollment WHERE expires_at > current_timestamp) AS enrolled`)
    if (state.protected || state.pending || state.enrolled) {
      throw new Error('Protected records, jobs or leases still block downgrade')
    }
    await runner.query('ALTER TABLE "job" DROP COLUMN "completeOutboundReconciling"')
    await runner.query('DROP TABLE complete_outbound_runner_enrollment')
  }
}
