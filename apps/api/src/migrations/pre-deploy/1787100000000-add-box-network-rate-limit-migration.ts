import { MigrationInterface, QueryRunner } from 'typeorm'

// Per-direction network bandwidth cap (kbit/s, from the box's point of view).
// Persisted because the Box row is the only carrier from the API to the
// runner — BoxStartAction hands the entity, not the request, to createBox —
// and because recover and stop/start replay the row. Nullable: absent means
// the caller never asked, which the core treats as uncapped. `integer`, not
// `bigint`: TypeORM maps bigint to a JS string, and int4's ceiling
// (~2.1 Tbit/s) is far above any real link.
export class AddBoxNetworkRateLimit1787100000000 implements MigrationInterface {
  name = 'AddBoxNetworkRateLimit1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "networkTxKbps" integer`)
    await queryRunner.query(`ALTER TABLE "box" ADD "networkRxKbps" integer`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "networkRxKbps"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "networkTxKbps"`)
  }
}
