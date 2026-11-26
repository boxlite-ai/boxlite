import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCompleteOutboundAcceptanceWindow1795096809000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE complete_outbound_admission
      ADD COLUMN acceptance_organization_id uuid,
      ADD COLUMN acceptance_expires_at timestamptz,
      ADD CONSTRAINT complete_outbound_acceptance_window_pair
        CHECK ((acceptance_organization_id IS NULL) = (acceptance_expires_at IS NULL))
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE complete_outbound_admission IN ACCESS EXCLUSIVE MODE')
    const [window] = await runner.query(
      "SELECT id FROM complete_outbound_admission WHERE phase = 'open' AND acceptance_organization_id IS NOT NULL",
    )
    if (window) throw new Error('Close the complete outbound acceptance window before reverting its migration')
    await runner.query(`
      ALTER TABLE complete_outbound_admission
      DROP CONSTRAINT complete_outbound_acceptance_window_pair,
      DROP COLUMN acceptance_organization_id,
      DROP COLUMN acceptance_expires_at
    `)
  }
}
