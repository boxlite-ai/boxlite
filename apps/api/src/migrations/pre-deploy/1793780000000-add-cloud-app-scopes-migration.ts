import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCloudAppScopes1793780000000 implements MigrationInterface {
  name = 'AddCloudAppScopes1793780000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "api_key" ADD COLUMN "cloudAppId" text')
    await queryRunner.query('CREATE INDEX "api_key_cloud_app_idx" ON "api_key" ("cloudAppId") WHERE "cloudAppId" IS NOT NULL')
    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      for (const permission of ['read:apps', 'write:apps', 'delete:apps']) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" ADD VALUE IF NOT EXISTS '${permission}'`)
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Revocation is necessary before removing the scope that limits these keys.
    await queryRunner.query('DELETE FROM "api_key" WHERE "cloudAppId" IS NOT NULL')
    await queryRunner.query('ALTER TABLE "api_key" DROP COLUMN "cloudAppId"')
    // Additive enum labels remain so existing role rows keep a readable representation.
  }
}
