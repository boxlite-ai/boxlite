/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomInt } from 'crypto'
import { MigrationInterface, QueryRunner } from 'typeorm'

const BOX_ID_LENGTH = 12
const BOX_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function generateBoxId(usedBoxIds: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let boxId = ''
    for (let i = 0; i < BOX_ID_LENGTH; i += 1) {
      boxId += BOX_ID_ALPHABET[randomInt(BOX_ID_ALPHABET.length)]
    }

    if (!usedBoxIds.has(boxId)) {
      usedBoxIds.add(boxId)
      return boxId
    }
  }

  throw new Error('Failed to generate a unique sandbox boxId')
}

export class Migration1780600000000 implements MigrationInterface {
  name = 'Migration1780600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" ADD "boxId" character varying(12)`)

    const rows = (await queryRunner.query(`SELECT "id", "boxId" FROM "sandbox"`)) as Array<{
      id: string
      boxId: string | null
    }>

    const usedBoxIds = new Set(rows.map((row) => row.boxId).filter((boxId): boxId is string => Boolean(boxId)))

    for (const row of rows) {
      if (row.boxId) {
        continue
      }
      await queryRunner.query(`UPDATE "sandbox" SET "boxId" = $1 WHERE "id" = $2`, [generateBoxId(usedBoxIds), row.id])
    }

    await queryRunner.query(`ALTER TABLE "sandbox" ALTER COLUMN "boxId" SET NOT NULL`)
    await queryRunner.query(`CREATE UNIQUE INDEX "sandbox_boxid_unique_idx" ON "sandbox" ("boxId")`)
    await queryRunner.query(`CREATE INDEX "sandbox_organizationid_boxid_idx" ON "sandbox" ("organizationId", "boxId")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."sandbox_organizationid_boxid_idx"`)
    await queryRunner.query(`DROP INDEX "public"."sandbox_boxid_unique_idx"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN "boxId"`)
  }
}
