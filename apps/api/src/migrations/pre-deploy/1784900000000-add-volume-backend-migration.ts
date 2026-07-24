import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddVolumeBackend1784900000000 implements MigrationInterface {
  name = 'AddVolumeBackend1784900000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."volume_backend_enum" AS ENUM('s3', 'ebs')`)
    await queryRunner.query(`ALTER TABLE "volume" ADD "backend" "public"."volume_backend_enum" NOT NULL DEFAULT 's3'`)
    await queryRunner.query(`ALTER TABLE "volume" ADD "sizeGiB" integer NOT NULL DEFAULT 10`)
    await queryRunner.query(`ALTER TABLE "volume" ADD "providerResourceId" character varying`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "volume" DROP COLUMN "providerResourceId"`)
    await queryRunner.query(`ALTER TABLE "volume" DROP COLUMN "sizeGiB"`)
    await queryRunner.query(`ALTER TABLE "volume" DROP COLUMN "backend"`)
    await queryRunner.query(`DROP TYPE "public"."volume_backend_enum"`)
  }
}
