import { MigrationInterface, QueryRunner } from 'typeorm'

/** The scope the registry credential routes add. The write and delete scopes are in the baseline. */
const REGISTRY_SCOPES = ['read:registries'] as const

/**
 * The scope enums as they stood before this migration, in order. Spelled out
 * rather than derived from today's enum, so that `down()` returns here and not
 * to whatever the enum has grown into by then.
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
  'read:images',
  'delete:images',
] as const

/** Each scope enum and the table whose `permissions` column it types. */
const SCOPE_ENUMS = [
  { type: 'api_key_permissions_enum', table: 'api_key' },
  { type: 'organization_role_permissions_enum', table: 'organization_role' },
] as const

const quoted = (scopes: readonly string[]) => scopes.map((scope) => `'${scope}'`).join(', ')

export class AddRegistryReadScope1790500000000 implements MigrationInterface {
  name = 'AddRegistryReadScope1790500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Appended, as the TypeScript enum appends, for the reason the image scopes
    // gave: an order that differs between the two is a change
    // `migration:generate` reports forever.
    for (const { type } of SCOPE_ENUMS) {
      for (const scope of REGISTRY_SCOPES) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${scope}'`)
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { type, table } of SCOPE_ENUMS) {
      // Postgres cannot drop an enum value, so the type is rebuilt around the
      // list before this migration, and any grant of the new scope is removed
      // first, or the cast onto the rebuilt type would fail on it.
      await queryRunner.query(
        `UPDATE "${table}" SET "permissions" = ARRAY(SELECT scope FROM unnest("permissions") AS scope WHERE scope NOT IN (${quoted(REGISTRY_SCOPES)})) WHERE "permissions" && ARRAY[${quoted(REGISTRY_SCOPES)}]::"public"."${type}"[]`,
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
