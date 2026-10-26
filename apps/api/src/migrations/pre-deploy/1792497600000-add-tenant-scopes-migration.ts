import { MigrationInterface, QueryRunner } from 'typeorm'

const TENANT_SCOPES = ['read:tenant', 'write:tenant'] as const

// Freeze the old order so rollback does not depend on future application enums.
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
  'read:registries',
  'write:images',
] as const

const SCOPE_ENUMS = [
  { type: 'api_key_permissions_enum', table: 'api_key' },
  { type: 'organization_role_permissions_enum', table: 'organization_role' },
] as const

const quoted = (scopes: readonly string[]) => scopes.map((scope) => `'${scope}'`).join(', ')

export class AddTenantScopes1792497600000 implements MigrationInterface {
  name = 'AddTenantScopes1792497600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { type } of SCOPE_ENUMS) {
      for (const scope of TENANT_SCOPES) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${scope}'`)
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { type, table } of SCOPE_ENUMS) {
      // PostgreSQL cannot drop enum values. Remove their grants before rebuilding.
      await queryRunner.query(
        `UPDATE "${table}" SET "permissions" = ARRAY(SELECT scope FROM unnest("permissions") AS scope WHERE scope NOT IN (${quoted(TENANT_SCOPES)})) WHERE "permissions" && ARRAY[${quoted(TENANT_SCOPES)}]::"public"."${type}"[]`,
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
