import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * MVP user-timing ledger: one table, `usage_period`. Spec snapshot + start/end
 * per segment; the billable amount is computed at read time (spec × duration).
 *
 * Intentionally NOT created here (added back as additive migrations when the
 * fuller design lands): the `actual*`/`sampleCount`/`sealed` columns, the
 * partial-unique "one open segment per box" index, and the end-after-start
 * CHECK. The column names/types match the fuller ledger, so those are pure
 * `ADD COLUMN` / `ADD CONSTRAINT` later (the partial-unique one needs a dedupe
 * pass first if any double-open rows slipped in).
 */
export class Migration1782600000000 implements MigrationInterface {
  name = 'Migration1782600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "usage_period" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "boxId" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "region" character varying,
        "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "periodEnd" TIMESTAMP WITH TIME ZONE,
        "kind" character varying NOT NULL,
        "allocCpu" integer NOT NULL,
        "allocMemGib" integer NOT NULL,
        "allocDiskGib" integer NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "usage_period_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE INDEX "usage_period_box_period_start_idx" ON "usage_period" ("boxId", "periodStart")`,
    )
    await queryRunner.query(
      `CREATE INDEX "usage_period_org_period_start_idx" ON "usage_period" ("organizationId", "periodStart")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "usage_period"`)
  }
}
