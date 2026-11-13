import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerDiskUsageSample1794528003000 implements MigrationInterface {
  name = 'AddRunnerDiskUsageSample1794528003000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // One bucket per (runner, sample-interval): the expansion cron upserts
    // every round, keeping the max usage seen inside a bucket so a spike
    // between rounds is never averaged away. `usedGiB` is the runner's df
    // "used" figure (currentAllocatedDiskGiB), not the sum of box disks. The
    // composite key is also the conflict target of that upsert, and the growth
    // scan reads buckets by runnerId in time order.
    await queryRunner.query(`CREATE TABLE "runner_disk_usage_sample" (
      "runnerId" uuid NOT NULL,
      "bucketAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "usedGiB" double precision NOT NULL,
      "capacityGiB" double precision NOT NULL,
      CONSTRAINT "runner_disk_usage_sample_runnerId_bucketAt_pk" PRIMARY KEY ("runnerId", "bucketAt"),
      CONSTRAINT "runner_disk_usage_sample_runnerId_fk" FOREIGN KEY ("runnerId") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "runner_disk_usage_sample"`)
  }
}
