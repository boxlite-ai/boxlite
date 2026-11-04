import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAppDomainEnvironment1793780200000 implements MigrationInterface {
  name = 'AddAppDomainEnvironment1793780200000'
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "domain" ADD COLUMN "environment_id" text')
    await queryRunner.query('CREATE INDEX "domain_app_environment_idx" ON "domain" ("environment_id") WHERE "environment_id" IS NOT NULL')
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "domain" DROP COLUMN "environment_id"')
  }
}
