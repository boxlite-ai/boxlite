import { MigrationInterface, QueryRunner } from 'typeorm'

export class NamespaceMigrationJobsUnderBackup1786320000000 implements MigrationInterface {
  name = 'NamespaceMigrationJobsUnderBackup1786320000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Migration jobs now take the BACKUP slot of IDX_UNIQUE_INCOMPLETE_JOB so they
    // stop competing with the box's own lifecycle jobs. Jobs submitted before this
    // deploy still hold the BOX slot, and a box whose migration job is in flight
    // could not be started or stopped until it completed, so move the ones still
    // open. Completed rows are left as they were: the index only covers incomplete
    // rows, and nothing reads resourceType off a finished job.
    //
    // `updatedAt` is deliberately untouched — JobService.handleStaleJobs measures
    // its 10-minute timeout from it, and stamping it here would grant every
    // in-flight migration job a fresh timeout.
    await queryRunner.query(
      `UPDATE "job" SET "resourceType" = 'BACKUP' WHERE "completedAt" IS NULL AND "resourceType" = 'BOX' AND "type" IN ('EXPORT_BOX', 'IMPORT_BOX', 'ROLLBACK_EXPORT_BOX', 'ROLLBACK_IMPORT_BOX', 'DISCARD_EXPORTED_BOX')`,
    )
  }

  public down(): Promise<void> {
    // Not reversed: moving these rows back into the BOX slot can collide with the
    // lifecycle job the split just allowed alongside them. Nothing needs it —
    // migration job status is applied by job type and resource id, never by
    // resource type, so either API version drives a BACKUP-namespaced job.
    return Promise.resolve()
  }
}
