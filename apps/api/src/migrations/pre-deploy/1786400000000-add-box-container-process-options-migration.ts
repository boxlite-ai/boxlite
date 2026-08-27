import { MigrationInterface, QueryRunner } from 'typeorm'

// The REST create surface has accepted `working_dir`, `entrypoint`, `cmd` and
// `user` since it existed, validated them, and audit-logged them — then dropped
// all four at the mapper. Persisting them is what lets a box be recreated on
// another runner after stop/start with the options the caller actually asked
// for. All four are nullable: absent means the image's own directives stand.
export class AddBoxContainerProcessOptions1786400000000 implements MigrationInterface {
  name = 'AddBoxContainerProcessOptions1786400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "runAsUser" character varying`)
    await queryRunner.query(`ALTER TABLE "box" ADD "workingDir" character varying`)
    await queryRunner.query(`ALTER TABLE "box" ADD "entrypoint" jsonb`)
    await queryRunner.query(`ALTER TABLE "box" ADD "cmd" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "cmd"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "entrypoint"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "workingDir"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "runAsUser"`)
  }
}
