import { MigrationInterface, QueryRunner } from 'typeorm'

export class IndexBoxOrganizationForProxy1795000000000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX CONCURRENTLY IF EXISTS box_organization_id_proxy_idx')
    await runner.query('CREATE UNIQUE INDEX CONCURRENTLY box_organization_id_proxy_idx ON box ("organizationId", id)')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX CONCURRENTLY IF EXISTS box_organization_id_proxy_idx')
  }
}
