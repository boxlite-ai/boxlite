import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationAppHostingPermissions1795564800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "public"."organization"
        ADD COLUMN app_hosting_permissions text[] NOT NULL DEFAULT '{}'::text[]
        CONSTRAINT organization_app_hosting_permissions_check
        CHECK (app_hosting_permissions <@ ARRAY['read:apps', 'write:apps', 'delete:apps']::text[])
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "public"."organization" DROP COLUMN app_hosting_permissions')
  }
}
