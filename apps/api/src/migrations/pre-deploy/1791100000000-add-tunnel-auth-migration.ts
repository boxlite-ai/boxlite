import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTunnelAuth1791100000000 implements MigrationInterface {
  name = 'AddTunnelAuth1791100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tunnel"
      ADD COLUMN "token_mask" character varying,
      ADD COLUMN "auth_generation" integer NOT NULL DEFAULT 1`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tunnel" DROP COLUMN "token_mask", DROP COLUMN "auth_generation"`)
  }
}
