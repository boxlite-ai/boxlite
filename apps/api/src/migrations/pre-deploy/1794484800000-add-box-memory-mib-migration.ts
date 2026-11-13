import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxMemoryMib1794484800000 implements MigrationInterface {
  transaction = true

  private async lock(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("SET LOCAL lock_timeout = '5s'")
    await queryRunner.query('LOCK TABLE "box" IN ACCESS EXCLUSIVE MODE')
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    await queryRunner.query('ALTER TABLE "box" ADD "memory_mib" integer')
    await queryRunner.query('UPDATE "box" SET "memory_mib" = "mem" * 1024')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await this.lock(queryRunner)
    await queryRunner.query('LOCK TABLE "checkpoint", "checkpoint_operation" IN ACCESS EXCLUSIVE MODE')
    const [result] = await queryRunner.query(`SELECT EXISTS (
      SELECT 1 FROM "box" WHERE "memory_mib" IS NOT NULL AND "memory_mib"::bigint <> "mem"::bigint * 1024
    ) AS unsafe`)
    if (result.unsafe) throw new Error('Cannot discard exact MiB allocations that differ from legacy GiB memory')
    for (const table of ['checkpoint', 'checkpoint_operation']) {
      const [snapshot] = await queryRunner.query(`SELECT EXISTS (
        SELECT 1 FROM "${table}" WHERE (environment->>'memoryMib')::bigint <>
          (environment->>'mem')::bigint * 1024
      ) AS unsafe`)
      if (snapshot.unsafe) throw new Error('Cannot discard exact MiB allocations retained in checkpoints')
    }
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "memory_mib"')
  }
}
