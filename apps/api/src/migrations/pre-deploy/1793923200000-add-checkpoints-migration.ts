import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCheckpoints1793923200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "job_resourcetype_enum" ADD VALUE IF NOT EXISTS 'CHECKPOINT'`)
    await queryRunner.query(`ALTER TABLE "box" ADD "checkpointJobId" uuid`)
    await queryRunner.query(`ALTER TABLE "box" ADD "checkpointSequence" integer NOT NULL DEFAULT 0`)
    await queryRunner.query(`CREATE TABLE "checkpoint" (
      "id" uuid NOT NULL, "organizationId" uuid NOT NULL, "name" varchar NOT NULL,
      "sourceBoxId" varchar NOT NULL, "sourceRunnerId" uuid NOT NULL, "sourceState" varchar NOT NULL,
      "state" varchar NOT NULL DEFAULT 'creating', "arcPath" varchar NOT NULL,
      "exportJobId" uuid, "activeJobId" uuid, "environment" jsonb NOT NULL,
      "archive" jsonb, "errorReason" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "checkpoint_id_pk" PRIMARY KEY ("id"),
      CONSTRAINT "checkpoint_state_check" CHECK ("state" IN ('creating','ready','failed','deleting'))
    )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "checkpoint_org_name_key" ON "checkpoint" ("organizationId", "name")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "checkpoint_active_job_key" ON "checkpoint" ("activeJobId") WHERE "activeJobId" IS NOT NULL`,
    )
    await queryRunner.query(`CREATE TABLE "checkpoint_operation" (
      "id" uuid NOT NULL PRIMARY KEY, "organizationId" uuid NOT NULL, "checkpointId" uuid NOT NULL,
      "boxId" varchar NOT NULL, "runnerId" uuid NOT NULL, "sequence" integer NOT NULL,
      "mode" varchar NOT NULL, "state" varchar NOT NULL DEFAULT 'pending', "jobId" uuid NOT NULL,
      "environment" jsonb NOT NULL, "platformEnv" jsonb NOT NULL, "nativeId" varchar, "errorReason" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "checkpoint_operation_state_check" CHECK ("state" IN ('pending','failed','completed','cancelled'))
    )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "checkpoint_operation_job_key" ON "checkpoint_operation" ("jobId")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "checkpoint_operation_target_sequence_key" ON "checkpoint_operation" ("boxId", "sequence")`,
    )
    await queryRunner.query(
      `CREATE INDEX "checkpoint_operation_use_idx" ON "checkpoint_operation" ("checkpointId", "state")`,
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = await queryRunner.query(`SELECT count(*)::int AS count FROM "checkpoint"`)
    const [jobs] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "job" WHERE "completedAt" IS NULL AND ("type" LIKE '%CHECKPOINT' OR "resourceType"::text = 'CHECKPOINT')`,
    )
    if (row.count !== 0 || jobs.count !== 0)
      throw new Error('Delete checkpoints and finish their jobs before reverting checkpoint storage')
    const [uses] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "checkpoint_operation" WHERE "state" IN ('pending','failed')`,
    )
    if (uses.count !== 0) throw new Error('Finish or cancel checkpoint operations before reverting checkpoint storage')
    await queryRunner.query(`DROP TABLE "checkpoint_operation"`)
    await queryRunner.query(`DROP TABLE "checkpoint"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "checkpointJobId"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "checkpointSequence"`)
    // PostgreSQL cannot remove an enum value without rebuilding the type and
    // its dependent job table. The unused additive value is safe to retain.
  }
}
