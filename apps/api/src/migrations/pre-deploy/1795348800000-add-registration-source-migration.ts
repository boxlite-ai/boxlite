import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRegistrationSource1795348800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user" ADD COLUMN "registrationSource" jsonb')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user" DROP COLUMN "registrationSource"')
  }
}
