import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCompleteOutboundControl1795096800000 implements MigrationInterface {
  name = 'AddCompleteOutboundControl1795096800000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "completeOutboundControl" jsonb NULL')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('LOCK TABLE "box" IN ACCESS EXCLUSIVE MODE')
    const [result] = await queryRunner.query(
      'SELECT EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL) AS protected',
    )
    if (result.protected) throw new Error('Complete outbound policy or pending work blocks downgrade')
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "completeOutboundControl"')
  }
}
