import { MigrationInterface, QueryRunner } from 'typeorm'

export class BoxSshAccessGeneration1784931971000 implements MigrationInterface {
  name = 'BoxSshAccessGeneration1784931971000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "box_ssh_access_generation" ("boxId" character varying NOT NULL, "generation" integer NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "box_ssh_access_generation_boxId_pk" PRIMARY KEY ("boxId"))`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_ssh_access_generation" ADD CONSTRAINT "box_ssh_access_generation_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "box_ssh_access_generation" DROP CONSTRAINT "box_ssh_access_generation_boxId_fk"`,
    )
    await queryRunner.query(`DROP TABLE "box_ssh_access_generation"`)
  }
}
