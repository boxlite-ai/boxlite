import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The scopes the catalog API enforces. There is no `write:images`: nothing
 * writes the catalog over HTTP — using an image is what records it.
 */
const IMAGE_SCOPES = ['read:images', 'delete:images'] as const

/**
 * The scope enums as the baseline created them, in baseline order. Spelled out
 * rather than derived from today's enum: this list is the pre-image `down()`
 * restores, so reading it from the TypeScript enum would make the reversal
 * follow whatever that enum grows next instead of returning here.
 */
const SCOPES_BEFORE = [
  'write:registries',
  'delete:registries',
  'write:templates',
  'delete:templates',
  'write:boxes',
  'delete:boxes',
  'read:volumes',
  'write:volumes',
  'delete:volumes',
  'write:regions',
  'delete:regions',
  'read:runners',
  'write:runners',
  'delete:runners',
  'read:audit_logs',
] as const

/** Each scope enum and the table whose `permissions` column it types. */
const SCOPE_ENUMS = [
  { type: 'api_key_permissions_enum', table: 'api_key' },
  { type: 'organization_role_permissions_enum', table: 'organization_role' },
] as const

const quoted = (scopes: readonly string[]) => scopes.map((scope) => `'${scope}'`).join(', ')

export class AddImageCatalogApi1787400000000 implements MigrationInterface {
  name = 'AddImageCatalogApi1787400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Both scope enums are Postgres enum types, and this is the first
    // migration in the tree to extend one. `ADD VALUE` runs inside a
    // transaction from Postgres 12 on, as long as the value is not used before
    // that transaction commits — nothing here uses one, and the targets are 16
    // (Cloud SQL) and 17 (local stack).
    //
    // Appended rather than grouped next to `*:boxes`, because `ADD VALUE`
    // without BEFORE/AFTER appends to the sort order: the TypeScript enum
    // appends too, and a divergence between the two orders would make
    // `migration:generate` report a change that is not one.
    for (const { type } of SCOPE_ENUMS) {
      for (const scope of IMAGE_SCOPES) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${scope}'`)
      }
    }

    // `image_tag.versionId` is a RESTRICT foreign key, and Postgres does not
    // index one for you: every delete of an `image_version` scans `image_tag`
    // whole looking for references. That scan sits on the path
    // `DELETE /images/:idOrRef` takes, so the index goes in with the endpoint
    // rather than being guessed at when the tables were created.
    await queryRunner.query(`CREATE INDEX "image_tag_version_index" ON "image_tag" ("versionId")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."image_tag_version_index"`)

    for (const { type, table } of SCOPE_ENUMS) {
      // Postgres cannot drop an enum value, so the type is rebuilt around the
      // baseline list — and a row still holding one of the image scopes would
      // fail the cast onto it. Strip them first: rolling this back removes the
      // routes that read them, so the grant no longer names anything.
      await queryRunner.query(
        `UPDATE "${table}" SET "permissions" = ARRAY(SELECT scope FROM unnest("permissions") AS scope WHERE scope NOT IN (${quoted(IMAGE_SCOPES)})) WHERE "permissions" && ARRAY[${quoted(IMAGE_SCOPES)}]::"public"."${type}"[]`,
      )
      await queryRunner.query(`ALTER TYPE "public"."${type}" RENAME TO "${type}_old"`)
      await queryRunner.query(`CREATE TYPE "public"."${type}" AS ENUM(${quoted(SCOPES_BEFORE)})`)
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "permissions" TYPE "public"."${type}"[] USING "permissions"::text[]::"public"."${type}"[]`,
      )
      await queryRunner.query(`DROP TYPE "public"."${type}_old"`)
    }
  }
}
