import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAdminUsageWindowIndexes1792470000000 implements MigrationInterface {
  transaction = false

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [index, table] of [
      ['idx_usage_live_end_start', 'box_usage_periods'],
      ['idx_usage_archive_end_start', 'box_usage_periods_archive'],
    ]) {
      const [existing] = await queryRunner.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [
        index,
      ])
      // Interrupted concurrent builds leave invalid indexes that IF NOT EXISTS would skip.
      if (existing?.indisvalid === false) await queryRunner.query(`DROP INDEX CONCURRENTLY ${index}`)
      await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}
        ON ${table} ("endAt", "startAt")`)
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_usage_archive_end_start`)
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_usage_live_end_start`)
  }
}
