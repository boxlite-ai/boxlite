import { MigrationInterface, QueryRunner } from 'typeorm'
import { ensureBoxOrganizationProxyIndex } from './box-organization-proxy-index'

export class RepairBoxOrganizationProxyIndex1795000000500 implements MigrationInterface {
  transaction = false

  up(runner: QueryRunner): Promise<void> {
    return ensureBoxOrganizationProxyIndex(runner)
  }

  down(): Promise<void> {
    // The original index migration owns the index, including its rollback.
    return Promise.resolve()
  }
}
