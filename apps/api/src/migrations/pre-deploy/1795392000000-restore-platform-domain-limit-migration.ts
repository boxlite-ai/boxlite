import { MigrationInterface, QueryRunner } from 'typeorm'

export class RestorePlatformDomainLimit1795392000000 implements MigrationInterface {
  name = 'RestorePlatformDomainLimit1795392000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 1')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback targets the release that granted twenty names to new organizations.
    await queryRunner.query('ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 20')
  }
}
