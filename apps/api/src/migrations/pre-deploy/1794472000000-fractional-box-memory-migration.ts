import { MigrationInterface, QueryRunner } from 'typeorm'

export class FractionalBoxMemory1794472000000 implements MigrationInterface {
  transaction = true

  private async lock(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'")
    await queryRunner.query('LOCK TABLE "box", "warm_pool" IN ACCESS EXCLUSIVE MODE')
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    await queryRunner.query('ALTER TABLE "box" ALTER COLUMN "mem" TYPE double precision USING "mem"::double precision')
    await queryRunner.query(
      'ALTER TABLE "warm_pool" ALTER COLUMN "mem" TYPE double precision USING "mem"::double precision',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    // Keep both locks until conversion completes; a concurrent fraction must not be rounded.
    const [result] = await queryRunner.query(`SELECT EXISTS (
      SELECT 1 FROM "box" WHERE "mem" <> trunc("mem") OR "mem" NOT BETWEEN -2147483648 AND 2147483647
      UNION ALL
      SELECT 1 FROM "warm_pool" WHERE "mem" <> trunc("mem") OR "mem" NOT BETWEEN -2147483648 AND 2147483647
    ) AS unsafe`)
    if (result.unsafe)
      throw new Error('Cannot restore integer memory columns while fractional or out-of-range allocations exist')
    await queryRunner.query('ALTER TABLE "box" ALTER COLUMN "mem" TYPE integer USING "mem"::integer')
    await queryRunner.query('ALTER TABLE "warm_pool" ALTER COLUMN "mem" TYPE integer USING "mem"::integer')
  }
}
