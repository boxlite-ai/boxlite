import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationVolumeQuota1784290000000 implements MigrationInterface {
  name = 'AddOrganizationVolumeQuota1784290000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_quota" ADD "max_volumes" integer NOT NULL DEFAULT '100'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_quota" DROP COLUMN "max_volumes"`)
  }
}
