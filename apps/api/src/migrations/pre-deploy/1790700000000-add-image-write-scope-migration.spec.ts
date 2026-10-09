import { QueryRunner } from 'typeorm'
import { AddImageWriteScope1790700000000 } from './1790700000000-add-image-write-scope-migration'

describe('AddImageWriteScope1790700000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddImageWriteScope1790700000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  it('appends the scope to both scope enums', async () => {
    const statements = await runMigration('up')

    // A key granted `write:images` against an enum that only one of them
    // knows is a 500 at insert time.
    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      expect(statements).toContain(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS 'write:images'`)
    }
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(BEFORE|AFTER|DROP)\b/)
    }
  })

  it('rebuilds each enum as it stood, keeping the scopes that were already there', async () => {
    const statements = await runMigration('down')

    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      const created = statements.find((statement) => statement.startsWith(`CREATE TYPE "public"."${type}"`))
      expect(created).toContain(`'read:images'`)
      expect(created).toContain(`'read:registries'`)
      expect(created).not.toContain(`'write:images'`)
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
      expect(statements[scrub]).toContain(`'write:images'`)
    }
  })
})
