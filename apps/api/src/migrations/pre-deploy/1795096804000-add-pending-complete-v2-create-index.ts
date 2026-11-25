import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPendingCompleteV2CreateIndex1795096804000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    const [existing] = await runner.query(`
      SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid = to_regclass('idx_box_pending_complete_v2_create') AND indrelid = 'box'::regclass
    `)
    if (existing?.valid) return
    if (existing) await this.down(runner)
    await runner.query(`CREATE INDEX CONCURRENTLY idx_box_pending_complete_v2_create ON "box" (id)
      WHERE pending AND "completeOutboundControl" #>> '{pending,transport}' = 'v2'`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_box_pending_complete_v2_create')
  }
}
