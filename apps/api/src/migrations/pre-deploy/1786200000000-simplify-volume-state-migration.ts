import { MigrationInterface, QueryRunner } from 'typeorm'

// Collapses volume_state_enum's pending_create/pending_delete stages into
// creating/destroying (the reconciler's per-volume Redis lock already
// distinguishes "queued" from "being processed" — a DB-level pending stage
// was redundant) and renames deleting/deleted to destroying/destroyed to
// match BoxState's vocabulary.
//
// Swaps the enum type rather than using ALTER TYPE ... ADD VALUE. Postgres
// refuses to *use* a label added by ADD VALUE until that transaction commits,
// and TypeORM runs migrations under one shared transaction by default
// (migrationsTransactionMode "all"), so ADD VALUE followed by an UPDATE to
// the new label fails outright. A type created in the same transaction is
// exempt from that rule, so building the new type and casting into it works
// in one shot. Safe here because volume.state is the only column using this
// type.
//
// The retired labels are carried into the replacement type on purpose. This
// runs pre-deploy, so instances on the previous release keep serving traffic
// while it lands, and those still write pending_create/pending_delete — a
// type without those labels would reject their writes for the length of the
// rollout. They can be dropped by a follow-up migration once no instance
// writes them.
export class SimplifyVolumeState1786200000000 implements MigrationInterface {
  name = 'SimplifyVolumeState1786200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."volume_state_enum_new" AS ENUM('creating', 'ready', 'destroying', 'destroyed', 'error', ` +
        // Retired: written only by instances still on the previous release
        // during a rolling deploy. No new row should reach them.
        `'pending_create', 'pending_delete', 'deleting', 'deleted')`,
    )
    // The default references the old type, so it has to go before the cast
    // and come back after.
    await queryRunner.query(`ALTER TABLE "volume" ALTER COLUMN "state" DROP DEFAULT`)
    await queryRunner.query(
      `ALTER TABLE "volume" ALTER COLUMN "state" TYPE "public"."volume_state_enum_new"
       USING (
         CASE "state"::text
           WHEN 'pending_create' THEN 'creating'
           WHEN 'pending_delete' THEN 'destroying'
           WHEN 'deleting' THEN 'destroying'
           WHEN 'deleted' THEN 'destroyed'
           ELSE "state"::text
         END
       )::"public"."volume_state_enum_new"`,
    )
    await queryRunner.query(`DROP TYPE "public"."volume_state_enum"`)
    await queryRunner.query(`ALTER TYPE "public"."volume_state_enum_new" RENAME TO "volume_state_enum"`)
    await queryRunner.query(`ALTER TABLE "volume" ALTER COLUMN "state" SET DEFAULT 'creating'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."volume_state_enum_old" AS ENUM('creating', 'ready', 'pending_create', 'pending_delete', 'deleting', 'deleted', 'error')`,
    )
    await queryRunner.query(`ALTER TABLE "volume" ALTER COLUMN "state" DROP DEFAULT`)
    // Best-effort only: collapsing pending_delete/deleting into destroying lost
    // which of the two a row was originally, so every destroying row reverts to
    // 'deleting' rather than its exact prior label. 'creating' rows are left
    // alone — it was already a valid state before this migration (a row there
    // could have started as either pending_create or creating), so there is no
    // correct single label to revert it to.
    await queryRunner.query(
      `ALTER TABLE "volume" ALTER COLUMN "state" TYPE "public"."volume_state_enum_old"
       USING (
         CASE "state"::text
           WHEN 'destroying' THEN 'deleting'
           WHEN 'destroyed' THEN 'deleted'
           ELSE "state"::text
         END
       )::"public"."volume_state_enum_old"`,
    )
    await queryRunner.query(`DROP TYPE "public"."volume_state_enum"`)
    await queryRunner.query(`ALTER TYPE "public"."volume_state_enum_old" RENAME TO "volume_state_enum"`)
    await queryRunner.query(`ALTER TABLE "volume" ALTER COLUMN "state" SET DEFAULT 'pending_create'`)
  }
}
