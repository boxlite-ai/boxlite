/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxSnapshotStates1791200000000 implements MigrationInterface {
  name = 'AddBoxSnapshotStates1791200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Appended without BEFORE/AFTER, as the TypeScript enum appends them.
    // Nothing in this migration uses either value, which is what lets ADD
    // VALUE run inside its transaction (Postgres 12 and later).
    await queryRunner.query(`ALTER TYPE "public"."box_state_enum" ADD VALUE IF NOT EXISTS 'exporting'`)
    await queryRunner.query(`ALTER TYPE "public"."box_state_enum" ADD VALUE IF NOT EXISTS 'importing'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop an enum value, so `exporting` and `importing` stay
    // on box_state_enum. A box left in either is put back to stopped instead.
    await queryRunner.query(
      `UPDATE "box" SET "state" = 'stopped' WHERE "state" IN ('exporting'::"public"."box_state_enum", 'importing'::"public"."box_state_enum")`,
    )
  }
}
