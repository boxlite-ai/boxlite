import { MigrationInterface, QueryRunner } from 'typeorm'

// Adds the filestore-volume support column. A volume row with a non-null
// `instance` is a filestore volume (its data directory lives on that NFS
// instance); null keeps the object-storage kind and its `boxlite-volume-<id>`
// bucket. Branch is unreleased, so no existing row carries a kind and the
// column ships nullable with no backfill.
export class VolumeInstanceColumn1792000000000 implements MigrationInterface {
  name = 'VolumeInstanceColumn1792000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "volume" ADD COLUMN IF NOT EXISTS "instance" character varying`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "volume" DROP COLUMN IF EXISTS "instance"`)
  }
}
