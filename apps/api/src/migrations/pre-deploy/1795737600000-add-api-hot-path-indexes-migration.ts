import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddApiHotPathIndexes1795737600000 implements MigrationInterface {
  transaction = false

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [index, definition] of [
      ['idx_runner_api_key', 'ON runner ("apiKey")'],
      ['idx_job_runner_status_created_at', 'ON job ("runnerId", status, "createdAt")'],
      ['idx_job_in_progress_updated_at', 'ON job ("updatedAt") WHERE status = \'IN_PROGRESS\''],
      ['idx_job_resource_created_at', 'ON job ("resourceType", "resourceId", "createdAt")'],
    ]) {
      const [existing] = await queryRunner.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [
        index,
      ])
      if (existing?.indisvalid === false) await queryRunner.query(`DROP INDEX CONCURRENTLY ${index}`)
      await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ${definition}`)
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_job_resource_created_at`)
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_job_in_progress_updated_at`)
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_job_runner_status_created_at`)
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_runner_api_key`)
  }
}
