import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerUnschedulableReason1791600000000 implements MigrationInterface {
  name = 'AddRunnerUnschedulableReason1791600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The column answers "whose mark is this": the expansion cron marks and
    // lifts only its own value. The operator endpoint flips the boolean only
    // and never writes the column, so operator marks stay reasonless by
    // design -- no backfill UPDATE for existing marks.
    await queryRunner.query(
      `CREATE TYPE "public"."runner_unschedulablereason_enum" AS ENUM('disk_expand_exhausted')`,
    )
    await queryRunner.query(`ALTER TABLE "runner" ADD "unschedulableReason" "public"."runner_unschedulablereason_enum"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "unschedulableReason"`)
    await queryRunner.query(`DROP TYPE "public"."runner_unschedulablereason_enum"`)
  }
}
