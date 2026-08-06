/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/** Repairs organizations stranded by the removed URL-only billing policy. */
export class UnsuspendLegacyPaymentOrganizations1786000600000 implements MigrationInterface {
  name = 'UnsuspendLegacyPaymentOrganizations1786000600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "organization"
         SET "suspended" = false,
             "suspendedAt" = NULL,
             "suspensionReason" = NULL,
             "suspendedUntil" = NULL
       WHERE "suspended" = true
         AND "suspensionReason" = 'Payment method required'
    `)
  }

  public async down(): Promise<void> {
    // Deliberately irreversible: rollback must not strand repaired customers.
  }
}
