import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPendingCompleteV0CreateIndex1795096801000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    const [existing] = await runner.query(`
      SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid = to_regclass('idx_box_pending_complete_v0_create') AND indrelid = 'box'::regclass
    `)
    if (existing?.valid) return
    if (existing) await this.down(runner)
    await runner.query(`CREATE INDEX CONCURRENTLY idx_box_pending_complete_v0_create ON "box" (id)
      WHERE pending AND "completeOutboundControl" #>> '{pending,transport}' = 'v0'`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_box_pending_complete_v0_create')
  }
}
