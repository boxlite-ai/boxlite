import { MigrationInterface, QueryRunner } from 'typeorm'

export class RaisePlatformDomainLimit1794528005000 implements MigrationInterface {
  name = 'RaisePlatformDomainLimit1794528005000'

  async up(): Promise<void> {
    // Keep this migration in TypeORM history for deployed databases. New installs inherit the one-name default.
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization" ALTER COLUMN "domain_count_limit" SET DEFAULT 1')
  }
}
