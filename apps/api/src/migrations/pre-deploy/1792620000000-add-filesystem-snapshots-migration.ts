import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddFilesystemSnapshots1792620000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "filesystem_snapshot" (
      "id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL, "runnerId" uuid NOT NULL,
      "nativeId" varchar NOT NULL, "sourceBoxId" varchar NOT NULL, "name" varchar NOT NULL,
      "metadata" jsonb NOT NULL, "createOptions" jsonb NOT NULL,
      UNIQUE ("organizationId", "sourceBoxId", "name")
    )`)
    await runner.query(`ALTER TABLE "box" ADD "snapshotId" varchar`)
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "box" DROP COLUMN "snapshotId"`)
    await runner.query(`DROP TABLE "filesystem_snapshot"`)
  }
}
