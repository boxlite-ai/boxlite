import { MigrationInterface, QueryRunner } from 'typeorm'

export class RenameMemberScopes1792728000000 implements MigrationInterface {
  name = 'RenameMemberScopes1792728000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.rename(queryRunner, 'tenant', 'members')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await this.rename(queryRunner, 'members', 'tenant')
  }

  private async rename(queryRunner: QueryRunner, from: 'tenant' | 'members', to: 'tenant' | 'members'): Promise<void> {
    for (const type of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      for (const action of ['read', 'write']) {
        await queryRunner.query(`ALTER TYPE "public"."${type}" RENAME VALUE '${action}:${from}' TO '${action}:${to}'`)
      }
    }
  }
}
