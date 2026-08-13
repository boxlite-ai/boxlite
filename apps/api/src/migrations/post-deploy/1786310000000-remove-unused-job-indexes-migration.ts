import { MigrationInterface, QueryRunner } from 'typeorm'

export class RemoveUnusedJobIndexes1786310000000 implements MigrationInterface {
  name = 'RemoveUnusedJobIndexes1786310000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_UNIQUE_INCOMPLETE_BACKUP_JOB"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_UNIQUE_INCOMPLETE_JOB"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_JOB" ON "job" ("resourceType", "resourceId", "runnerId") WHERE "completedAt" IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_UNIQUE_INCOMPLETE_JOB"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_JOB" ON "job" ("resourceType", "resourceId", "runnerId") WHERE "completedAt" IS NULL AND "type" != 'CREATE_BACKUP'`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_BACKUP_JOB" ON "job" ("resourceType", "resourceId", "runnerId") WHERE "completedAt" IS NULL AND "type" = 'CREATE_BACKUP'`,
    )
  }
}
