import { MigrationInterface, QueryRunner } from 'typeorm'

const proxyScopes = ['write:proxies', 'delete:proxies']
const previousScopes = [
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
  'read:members',
  'write:members',
]
const tables = [
  ['api_key', 'api_key_permissions_enum'],
  ['organization_role', 'organization_role_permissions_enum'],
] as const
const quoted = (scopes: string[]) => scopes.map((scope) => `'${scope}'`).join(', ')

export class AddOutboundProxyPermissions1795000002000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const [, type] of tables) {
      for (const scope of proxyScopes) {
        await runner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${scope}'`)
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const [table, type] of tables) {
      await runner.query(`UPDATE "${table}" SET "permissions" = ARRAY(
        SELECT scope FROM unnest("permissions") AS scope WHERE scope NOT IN (${quoted(proxyScopes)})
      ) WHERE "permissions" && ARRAY[${quoted(proxyScopes)}]::"public"."${type}"[]`)
      await runner.query(`ALTER TYPE "public"."${type}" RENAME TO "${type}_old"`)
      await runner.query(`CREATE TYPE "public"."${type}" AS ENUM(${quoted(previousScopes)})`)
      await runner.query(`ALTER TABLE "${table}" ALTER COLUMN "permissions" TYPE "public"."${type}"[]
        USING "permissions"::text[]::"public"."${type}"[]`)
      await runner.query(`DROP TYPE "public"."${type}_old"`)
    }
  }
}
