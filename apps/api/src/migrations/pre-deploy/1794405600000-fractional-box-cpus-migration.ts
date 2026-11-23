import { MigrationInterface, QueryRunner } from 'typeorm'

export class FractionalBoxCpus1794405600000 implements MigrationInterface {
  transaction = true

  private async lock(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'")
    await queryRunner.query('LOCK TABLE "box", "warm_pool" IN ACCESS EXCLUSIVE MODE')
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    await queryRunner.query('ALTER TABLE "box" ALTER COLUMN "cpu" TYPE double precision USING "cpu"::double precision')
    await queryRunner.query(
      'ALTER TABLE "warm_pool" ALTER COLUMN "cpu" TYPE double precision USING "cpu"::double precision',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    // Hold both locks through the check and conversion so concurrent writes
    // cannot introduce fractions that PostgreSQL would round when casting.
    const [result] = await queryRunner.query(`SELECT EXISTS (
      SELECT 1 FROM "box" WHERE "cpu" <> trunc("cpu") OR "cpu" NOT BETWEEN -2147483648 AND 2147483647
      UNION ALL
      SELECT 1 FROM "warm_pool" WHERE "cpu" <> trunc("cpu") OR "cpu" NOT BETWEEN -2147483648 AND 2147483647
    ) AS unsafe`)
    if (result.unsafe)
      throw new Error('Cannot restore integer CPU columns while fractional or out-of-range allocations exist')
    await queryRunner.query('ALTER TABLE "box" ALTER COLUMN "cpu" TYPE integer USING "cpu"::integer')
    await queryRunner.query('ALTER TABLE "warm_pool" ALTER COLUMN "cpu" TYPE integer USING "cpu"::integer')
  }
}
