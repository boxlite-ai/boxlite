import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCloudAppScopes1793780000000 implements MigrationInterface {
  name = 'AddCloudAppScopes1793780000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      for (const permission of ['read:apps', 'write:apps', 'delete:apps']) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${permission}'`)
      }
    }
  }

  async down(): Promise<void> {
    // Additive enum labels remain so existing role rows keep a readable representation.
  }
}
