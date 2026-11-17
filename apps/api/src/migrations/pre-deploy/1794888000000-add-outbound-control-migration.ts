import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOutboundControl1794888000000 implements MigrationInterface {
  name = 'AddOutboundControl1794888000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "outboundControl" jsonb NULL')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "outboundControl"')
  }
}
