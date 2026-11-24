import { MigrationInterface, QueryRunner } from 'typeorm'
import { dropBoxOrganizationProxyIndex, ensureBoxOrganizationProxyIndex } from './box-organization-proxy-index'

export class IndexBoxOrganizationForProxy1795000000000 implements MigrationInterface {
  transaction = false

  up(runner: QueryRunner): Promise<void> {
    return ensureBoxOrganizationProxyIndex(runner)
  }

  down(runner: QueryRunner): Promise<void> {
    return dropBoxOrganizationProxyIndex(runner)
  }
}
