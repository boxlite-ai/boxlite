import { QueryRunner } from 'typeorm'
import { AddImageCatalogApi1787400000000 } from './1787400000000-add-image-catalog-api-migration'

describe('AddImageCatalogApi1787400000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddImageCatalogApi1787400000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  const SCOPE_ENUMS = ['api_key_permissions_enum', 'organization_role_permissions_enum']

  it('adds both image scopes to both scope enums', async () => {
    const statements = await runMigration('up')

    // Two enum types carry these scopes, and a key granted `read:images`
    // against an enum that only one of them knows is a 500 at insert time.
    // This is the schema-level sibling of the two permission group files the
    // console reads: the pair is the unit, not either half.
    for (const type of SCOPE_ENUMS) {
      for (const scope of ['read:images', 'delete:images']) {
        expect(statements).toContain(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${scope}'`)
      }
    }
  })

  it('appends the scopes rather than positioning them', async () => {
    const statements = await runMigration('up')
    const addValues = statements.filter((statement) => statement.includes('ADD VALUE'))

    // The TypeScript enum appends too. Positioning one side with BEFORE/AFTER
    // would put the two enums in different orders, which `migration:generate`
    // then reports as a pending change forever.
    expect(addValues).toHaveLength(4)
    for (const statement of addValues) {
      expect(statement).not.toMatch(/\b(BEFORE|AFTER)\b/)
    }
  })

  it('indexes the restricting foreign key the delete path walks', async () => {
    const statements = await runMigration('up')

    expect(statements).toContain(`CREATE INDEX "image_tag_version_index" ON "image_tag" ("versionId")`)
  })

  it('changes nothing an older API could be reading', async () => {
    const sql = (await runMigration('up')).join('\n')

    // Pre-deploy runs against the API being replaced, so every statement here
    // has to be one that API can ignore.
    expect(sql).not.toContain('DROP')
    expect(sql).not.toContain('ALTER COLUMN')
  })

  it('rebuilds each enum without the image scopes', async () => {
    const statements = await runMigration('down')
    const sql = statements.join('\n')

    for (const type of SCOPE_ENUMS) {
      const created = statements.find((statement) => statement.startsWith(`CREATE TYPE "public"."${type}"`))
      expect(created).toBeDefined()
      // The point of the reversal: the rebuilt type is the baseline list, so
      // it must have kept the scopes that were always there and dropped only
      // the two this migration added.
      expect(created).toContain(`'read:audit_logs'`)
      expect(created).toContain(`'write:boxes'`)
      expect(created).not.toContain(`'read:images'`)
      expect(created).not.toContain(`'delete:images'`)
    }
    expect(sql).toContain(`DROP INDEX IF EXISTS "public"."image_tag_version_index"`)
  })

  it('strips the granted scopes before the type that still allows them is gone', async () => {
    const statements = await runMigration('down')

    for (const { type, table } of [
      { type: 'api_key_permissions_enum', table: 'api_key' },
      { type: 'organization_role_permissions_enum', table: 'organization_role' },
    ]) {
      const scrub = statements.findIndex((statement) => statement.startsWith(`UPDATE "${table}"`))
      const rename = statements.findIndex((statement) => statement.includes(`ALTER TYPE "public"."${type}" RENAME`))
      const drop = statements.findIndex((statement) => statement.includes(`DROP TYPE "public"."${type}_old"`))

      // A role still holding `read:images` fails the cast onto the rebuilt
      // type, so the scrub has to run while the old type still accepts the
      // value — that is, before the rename.
      expect(scrub).toBeGreaterThanOrEqual(0)
      expect(scrub).toBeLessThan(rename)
      expect(rename).toBeLessThan(drop)
    }
  })
})
