import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAuditResponseLease1794300000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE audit_log ADD COLUMN "leaseExpiresAt" timestamptz')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE audit_log DROP COLUMN "leaseExpiresAt"')
  }
}
