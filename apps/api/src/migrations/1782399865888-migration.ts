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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."usage_period_org_period_start_idx"`)
    await queryRunner.query(`DROP INDEX "public"."usage_period_box_period_start_idx"`)
    await queryRunner.query(`DROP TABLE "usage_period"`)
  }
}
