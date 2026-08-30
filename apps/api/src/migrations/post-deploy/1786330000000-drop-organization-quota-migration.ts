import { MigrationInterface, QueryRunner } from 'typeorm'

export class DropOrganizationQuota1786330000000 implements MigrationInterface {
  name = 'DropOrganizationQuota1786330000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "organization_quota"')
  }

  public down(): Promise<void> {
    // The retired control-plane quota data has no lossless representation after
    // billing becomes its owner, so rolling back must not recreate an empty table.
    return Promise.resolve()
  }
}
