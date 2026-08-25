import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxAdvancedOptions1785819202000 implements MigrationInterface {
  name = 'AddBoxAdvancedOptions1785819202000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "privileged" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "capabilities" jsonb NOT NULL DEFAULT '{"add":[],"drop":[]}'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "capabilities"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "privileged"`)
  }
}
