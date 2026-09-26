import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationInvitationAttribution1790035200000 implements MigrationInterface {
  name = 'AddOrganizationInvitationAttribution1790035200000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization"
      ADD "referredCode" varchar(10),
      ADD "inviterOrganizationId" uuid`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization"
      DROP COLUMN "inviterOrganizationId",
      DROP COLUMN "referredCode"`)
  }
}
