/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 *
 * No-op stub. The security-options sandbox columns (requestedSecurityOptions,
 * effectiveSecurityOptions, securityPolicyResult) were originally placed here
 * but moved to 1770880371268-migration.ts because this timestamp predates the
 * workspace→sandbox table rename (1749474791344), causing a fresh-DB failure.
 *
 * The class name preserves the original numeric suffix so TypeORM can parse
 * the timestamp for ordering and migration-log tracking.
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1747094400000 implements MigrationInterface {
  name = 'Migration1747094400000'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op: see 1770880371268-migration.ts
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op: see 1770880371268-migration.ts
  }
}
