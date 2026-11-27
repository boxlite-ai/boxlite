import { MigrationInterface, QueryRunner } from 'typeorm'

export class ProductAnalyticsConsent1795420800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE product_analytics_consent (
      user_id varchar PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      allowed boolean NOT NULL,
      notice_version integer NOT NULL,
      decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE product_analytics_consent')
  }
}
