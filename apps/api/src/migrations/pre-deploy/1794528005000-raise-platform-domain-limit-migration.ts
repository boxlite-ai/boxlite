import { MigrationInterface, QueryRunner } from 'typeorm'

export class RaisePlatformDomainLimit1794528005000 implements MigrationInterface {
  name = 'RaisePlatformDomainLimit1794528005000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 20')
    await queryRunner.query('UPDATE "organization" SET "domain_count_limit" = 20 WHERE "domain_count_limit" = 1')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Keep current allowances so a rollback does not strand names claimed after the increase.
    await queryRunner.query('ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 1')
  }
}
