import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCompleteOutboundAdmission1795096802000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE complete_outbound_admission (
      id integer PRIMARY KEY CHECK (id = 1),
      phase text NOT NULL CHECK (phase IN ('closed', 'open', 'downgrading')),
      minimum_release text CHECK (minimum_release IS NULL OR length(minimum_release) > 0),
      api_principal name,
      deployment_receipt text CHECK (deployment_receipt IS NULL OR length(deployment_receipt) > 0),
      CHECK (phase <> 'open' OR (minimum_release IS NOT NULL AND api_principal IS NOT NULL AND deployment_receipt IS NOT NULL))
    )`)
    await runner.query("INSERT INTO complete_outbound_admission (id, phase) VALUES (1, 'closed')")
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
    await runner.query('LOCK TABLE "box" IN ACCESS EXCLUSIVE MODE')
    const [records] = await runner.query(
      'SELECT EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL) AS protected',
    )
    if (records.protected) throw new Error('Complete outbound policy or pending work blocks downgrade')
    await runner.query('DROP TABLE complete_outbound_admission')
  }
}
