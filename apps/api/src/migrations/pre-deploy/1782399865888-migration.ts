import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782399865888 implements MigrationInterface {
  name = 'Migration1782399865888'

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
        "actualCpuSeconds" double precision,
        "actualRssAvgBytes" bigint,
        "actualRssPeakBytes" bigint,
        "sampleCount" integer,
        "sealed" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "usage_period_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "usage_period_box_period_start_idx" ON "usage_period" ("boxId", "periodStart")`,
    )
    await queryRunner.query(
      `CREATE INDEX "usage_period_org_period_start_idx" ON "usage_period" ("organizationId", "periodStart")`,
    )
    // At most one open period per box — partial unique index on the open rows.
    // Makes the "two concurrent state events both open a period" race fail the
    // second insert (caught + logged) instead of double-counting in queries.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "usage_period_one_open_per_box_idx" ON "usage_period" ("boxId") WHERE "periodEnd" IS NULL`,
    )
    // A period can never end before it starts (clock skew / bad reconcile).
    // Reject impossible orderings at write time so SUM(end-start) is never negative.
    await queryRunner.query(
      `ALTER TABLE "usage_period" ADD CONSTRAINT "usage_period_end_after_start" CHECK ("periodEnd" IS NULL OR "periodEnd" >= "periodStart")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usage_period" DROP CONSTRAINT "usage_period_end_after_start"`)
    await queryRunner.query(`DROP INDEX "public"."usage_period_one_open_per_box_idx"`)
    await queryRunner.query(`DROP INDEX "public"."usage_period_org_period_start_idx"`)
    await queryRunner.query(`DROP INDEX "public"."usage_period_box_period_start_idx"`)
    await queryRunner.query(`DROP TABLE "usage_period"`)
  }
}
