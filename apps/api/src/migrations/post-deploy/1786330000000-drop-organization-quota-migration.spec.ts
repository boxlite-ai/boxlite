import { QueryRunner } from 'typeorm'
import { DropOrganizationQuota1786330000000 } from './1786330000000-drop-organization-quota-migration'

describe('DropOrganizationQuota1786330000000', () => {
  it('removes the retired table idempotently', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner

    const migration = new DropOrganizationQuota1786330000000()
    await migration.up(queryRunner)
    await migration.up(queryRunner)

    expect(queryRunner.query).toHaveBeenNthCalledWith(1, 'DROP TABLE IF EXISTS "organization_quota"')
    expect(queryRunner.query).toHaveBeenNthCalledWith(2, 'DROP TABLE IF EXISTS "organization_quota"')
  })
})
