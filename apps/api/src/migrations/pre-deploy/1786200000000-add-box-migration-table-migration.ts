import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxMigrationTable1786200000000 implements MigrationInterface {
  name = 'AddBoxMigrationTable1786200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."box_migration_state_enum" AS ENUM('pending_export', 'pending_import', 'pending_discard_exported', 'pending_rollback', 'completed')`,
    )
    // One row per migration in flight, keyed by the box it moves. There is no
    // "not migrating" state: that is the absence of a row, which is also what
    // the cascade leaves behind when the box goes away.
    //
    // `arcPath` is empty, not null, when there is no archive to reclaim — the
    // rollback path tests it for emptiness, and one sentinel keeps that a plain
    // comparison instead of a null-or-empty pair. `updatedAt` is NOT NULL
    // because the marker copies `box.updatedAt` into it in the statement that
    // creates the row.
    await queryRunner.query(
      `CREATE TABLE "box_migration" ("boxId" character varying NOT NULL, "state" "public"."box_migration_state_enum" NOT NULL, "arcPath" character varying NOT NULL DEFAULT '', "runnerId" uuid, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "box_migration_boxId_pk" PRIMARY KEY ("boxId"), CONSTRAINT "box_migration_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    // The migration loops scan by state, and every row in this table is a
    // migration in flight, so the index covers the whole table.
    await queryRunner.query(`CREATE INDEX "box_migration_state_idx" ON "box_migration" ("state")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_migration_state_idx"`)
    await queryRunner.query(`DROP TABLE "box_migration"`)
    await queryRunner.query(`DROP TYPE "public"."box_migration_state_enum"`)
  }
}
