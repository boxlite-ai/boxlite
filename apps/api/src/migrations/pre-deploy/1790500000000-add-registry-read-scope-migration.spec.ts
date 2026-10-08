import { QueryRunner } from 'typeorm'
import { AddRegistryReadScope1790500000000 } from './1790500000000-add-registry-read-scope-migration'

describe('AddRegistryReadScope1790500000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddRegistryReadScope1790500000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  it('appends the scope to both scope enums', async () => {
    const statements = await runMigration('up')

    // A key granted `read:registries` against an enum that only one of them
    // knows is a 500 at insert time.
    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      expect(statements).toContain(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS 'read:registries'`)
    }
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(BEFORE|AFTER|DROP)\b/)
    }
  })

  it('rebuilds each enum as it stood, keeping the scopes that were already there', async () => {
    const statements = await runMigration('down')

    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      const created = statements.find((statement) => statement.startsWith(`CREATE TYPE "public"."${type}"`))
      expect(created).toContain(`'write:registries'`)
      expect(created).toContain(`'delete:images'`)
      expect(created).not.toContain(`'read:registries'`)
    }
  })

  it('strips grants of the scope before the type that still allows them is gone', async () => {
    const statements = await runMigration('down')

    for (const { type, table } of [
      { type: 'api_key_permissions_enum', table: 'api_key' },
      { type: 'organization_role_permissions_enum', table: 'organization_role' },
    ]) {
      const scrub = statements.findIndex((statement) => statement.startsWith(`UPDATE "${table}"`))
      const rename = statements.findIndex((statement) => statement.startsWith(`ALTER TYPE "public"."${type}" RENAME`))
      // A key or role still holding it would fail the cast onto the rebuilt type.
      expect(scrub).toBeGreaterThanOrEqual(0)
      expect(scrub).toBeLessThan(rename)
      expect(statements[scrub]).toContain(`'read:registries'`)
    }
  })
})
