import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCloudResizeJobs1793232000000 implements MigrationInterface {
  name = 'AddCloudResizeJobs1793232000000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "box" ADD COLUMN "resizeJobId" uuid`)
    await runner.query(`ALTER TABLE "job"
      ADD COLUMN "resizePhase" varchar,
      ADD COLUMN "nextAttemptAt" timestamptz,
      ADD COLUMN "attempt" integer NOT NULL DEFAULT 0,
      ADD COLUMN "claimToken" uuid,
      ADD COLUMN "leaseExpiresAt" timestamptz`)
    await runner.query(`CREATE INDEX "job_resize_due_idx" ON "job" ("runnerId", "nextAttemptAt")
      WHERE "type" = 'RESIZE_BOX' AND "status" = 'PENDING' AND "resizePhase" = 'APPLY'`)
  }

  async down(runner: QueryRunner): Promise<void> {
    // An old API cannot safely consume leased resize jobs.
    const [{ count }] = await runner.query(`SELECT count(*) FROM "job"
      WHERE "type" = 'RESIZE_BOX' AND "completedAt" IS NULL`)
    if (Number(count)) throw new Error('Drain resize jobs before reverting their schema')
    await runner.query(`DROP INDEX "job_resize_due_idx"`)
    await runner.query(`ALTER TABLE "job" DROP COLUMN "resizePhase", DROP COLUMN "nextAttemptAt",
      DROP COLUMN "attempt", DROP COLUMN "claimToken", DROP COLUMN "leaseExpiresAt"`)
    await runner.query(`ALTER TABLE "box" DROP COLUMN "resizeJobId"`)
  }
}
