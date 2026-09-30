import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationExecTimeout1790640000000 implements MigrationInterface {
  name = 'AddOrganizationExecTimeout1790640000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization"
      ADD "defaultExecTimeoutSeconds" integer,
      ADD CONSTRAINT "organization_default_exec_timeout_nonnegative" CHECK ("defaultExecTimeoutSeconds" >= 0)`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization" DROP COLUMN "defaultExecTimeoutSeconds"`)
  }
}
