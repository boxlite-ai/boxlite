import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782307383251 implements MigrationInterface {
  name = 'Migration1782307383251'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "box_org_createdat_idx" ON "box" ("organizationId", "createdAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_org_createdat_idx"`)
  }
}
