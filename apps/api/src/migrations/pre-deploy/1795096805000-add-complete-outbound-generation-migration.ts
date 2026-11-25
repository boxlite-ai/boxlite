import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCompleteOutboundGeneration1795096805000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "box" ADD "completeOutboundGeneration" integer NOT NULL DEFAULT 0')
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
      'SELECT EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL OR "completeOutboundGeneration" <> 0) AS protected',
    )
    if (records.protected) throw new Error('Complete outbound records or generation floors block downgrade')
    await runner.query('ALTER TABLE "box" DROP COLUMN "completeOutboundGeneration"')
  }
}
