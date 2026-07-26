import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Contract-phase migration for CA-based real SSH: drops the legacy SSH login
 * token table.
 *
 * DO NOT RUN THIS UNTIL THE PHASE 5 CHECKPOINT IS APPROVED.
 *
 * The delay is rollback safety, not a compatibility window. The Legacy SSH
 * Token routes were deleted outright in the same release that added the
 * certificate resource, so nothing reads `ssh_access` any more. The table
 * survives only so the application code can be rolled back while unexpired
 * legacy state still exists. Once this runs, roll-forward is the only option:
 * a rollback past this point cannot restore token authentication, and the rows
 * are gone.
 *
 * `down()` recreates the empty table so the migration is reversible in shape,
 * but it deliberately does NOT resurrect any data — the tokens were
 * plaintext bearer credentials and re-populating them is neither possible nor
 * desirable.
 */
export class DropLegacySshAccess1785041500000 implements MigrationInterface {
  name = 'DropLegacySshAccess1785041500000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ssh_access"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Shape-only restore, reproducing the baseline DDL exactly (note `boxId`
    // is `character varying`, matching `box.id` — not uuid). The original
    // table stored a plaintext login token and its expiry; both are
    // meaningless without the deleted issuance and validation endpoints, so no
    // data is restored.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "ssh_access" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying NOT NULL, "token" text NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "ssh_access_id_pk" PRIMARY KEY ("id"), CONSTRAINT "ssh_access_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
  }
}
