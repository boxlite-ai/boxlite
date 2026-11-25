import { MigrationInterface, QueryRunner } from 'typeorm'

const indexes = [
  ['idx_job_protected_checkpoint_claim', '"runnerId", "updatedAt", id'],
  ['idx_job_protected_checkpoint_reconcile', 'id'],
] as const

export class AddProtectedCheckpointQueueIndexes1795096808000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    for (const [name, keys] of indexes) {
      const [existing] = await runner.query(
        `SELECT indisvalid AS valid FROM pg_index
         WHERE indexrelid = to_regclass($1) AND indrelid = 'job'::regclass`,
        [name],
      )
      if (existing?.valid) continue
      if (existing) await runner.query(`DROP INDEX CONCURRENTLY ${name}`)
      await runner.query(`CREATE INDEX CONCURRENTLY ${name} ON "job" (${keys})
        WHERE type IN ('EXPORT_PROTECTED_CHECKPOINT', 'UPLOAD_PROTECTED_CHECKPOINT', 'IMPORT_PROTECTED_CHECKPOINT')
          AND ("completedAt" IS NULL OR "checkpointCleanupRequired")`)
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const [name] of indexes) await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)
  }
}
