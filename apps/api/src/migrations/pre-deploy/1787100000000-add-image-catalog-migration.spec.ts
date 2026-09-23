import { QueryRunner } from 'typeorm'
import { AddImageCatalog1787100000000 } from './1787100000000-add-image-catalog-migration'

describe('AddImageCatalog1787100000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddImageCatalog1787100000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  it('creates the catalog tables with the constraints that carry the design', async () => {
    const statements = await runMigration('up')
    const sql = statements.join('\n')

    expect(sql).toContain(`CREATE TYPE "public"."image_version_state_enum" AS ENUM('ready', 'deleted')`)
    expect(sql).toContain(`CREATE TYPE "public"."image_source_kind_enum" AS ENUM('pull')`)

    // A soft-deleted name has to be reusable, which only a partial index can
    // express. Volume's table-level constraint is the bug this avoids.
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "image_org_name_active_unique" ON "image" ("organizationId", "name") WHERE "deletedAt" IS NULL`,
    )

    // Registry paths are long and reach URLs and route params, so the name is
    // the full upstream repository rather than a short user-chosen one.
    expect(sql).toContain(`"name" character varying(255) NOT NULL`)

    // The manifest digest is `sha256:` plus 64 hex characters.
    expect(sql).toContain(`"digest" character varying(71) NOT NULL`)
    expect(sql).toContain(`"sizeBytes" bigint NOT NULL`)
    expect(sql).toContain(`CONSTRAINT "image_version_image_digest_unique" UNIQUE ("imageId", "digest")`)

    // A version a tag still names must not disappear underneath it.
    expect(sql).toContain(
      `CONSTRAINT "image_tag_versionId_fk" FOREIGN KEY ("versionId") REFERENCES "image_version"("id") ON DELETE RESTRICT`,
    )
    // Versions and tags go away with their image, which is what makes a
    // catalog delete a single statement.
    expect(sql).toContain(
      `CONSTRAINT "image_version_imageId_fk" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE CASCADE`,
    )
    expect(sql).toContain(
      `CONSTRAINT "image_tag_imageId_fk" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE CASCADE`,
    )

    // Additive only, so the API being replaced can ignore it.
    expect(sql).toContain(`ALTER TABLE "organization" ADD "image_count_limit" integer NOT NULL DEFAULT 20`)
    expect(sql).not.toContain('DROP COLUMN')
  })

  /**
   * Not a style preference. A `NOT NULL DEFAULT` would claim every existing box
   * was decided one way, and the reader distinguishes "recorded false" from
   * "never recorded" — the second is what keeps old rows on the behaviour they
   * have always had instead of silently changing which ones pull anonymously.
   *
   * Checked on the box statements alone: the catalog tables beside them carry
   * defaults of their own, and their foreign keys spell `ON UPDATE`.
   */
  it('records box image ownership without deciding it for existing boxes', async () => {
    const statements = await runMigration('up')

    expect(statements.filter((statement) => statement.includes('"box"'))).toEqual([
      `ALTER TABLE "box" ADD "imageIsOrgOwned" boolean`,
    ])
    expect(statements.filter((statement) => /^\s*UPDATE\b/i.test(statement))).toEqual([])
  })

  it('reverses everything it created', async () => {
    const statements = await runMigration('down')
    const sql = statements.join('\n')

    for (const table of ['image_tag', 'image_version', 'image']) {
      expect(sql).toContain(`DROP TABLE "${table}"`)
    }
    expect(sql).toContain(`DROP TYPE "public"."image_source_kind_enum"`)
    expect(sql).toContain(`DROP TYPE "public"."image_version_state_enum"`)
    expect(sql).toContain(`ALTER TABLE "organization" DROP COLUMN "image_count_limit"`)
    expect(sql).toContain(`ALTER TABLE "box" DROP COLUMN "imageIsOrgOwned"`)

    // The tag table references the version table, so it has to go first.
    expect(statements.findIndex((s) => s.includes(`DROP TABLE "image_tag"`))).toBeLessThan(
      statements.findIndex((s) => s.includes(`DROP TABLE "image_version"`)),
    )
  })
})
