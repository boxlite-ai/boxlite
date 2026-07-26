import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxCapabilities1785000000000 implements MigrationInterface {
  name = 'AddBoxCapabilities1785000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "box" ADD "advanced" jsonb NOT NULL DEFAULT '{"capabilities":{"add":[],"drop":[]}}'::jsonb`,
    )
    await queryRunner.query(`ALTER TABLE "runner" ADD "features" jsonb NOT NULL DEFAULT '[]'::jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ hasCustomPolicy }] = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM "box"
        WHERE "advanced" <> '{"capabilities":{"add":[],"drop":[]}}'::jsonb
      ) AS "hasCustomPolicy"
    `)) as Array<{ hasCustomPolicy: boolean }>
    if (hasCustomPolicy) {
      throw new Error(
        'Cannot roll back advanced options while boxes have custom Linux capability policies',
      )
    }

    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "features"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "advanced"`)
  }
}
