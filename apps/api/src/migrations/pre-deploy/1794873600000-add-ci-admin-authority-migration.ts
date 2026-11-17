/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCiAdminAuthority1794873600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("SET LOCAL lock_timeout='2s'")
    await runner.query('ALTER TABLE ci_installation_binding ADD COLUMN admin_managed boolean NOT NULL DEFAULT false')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query("SET LOCAL lock_timeout='2s'")
    await runner.query('LOCK TABLE ci_installation_binding IN ACCESS EXCLUSIVE MODE')
    const [binding] = await runner.query('SELECT 1 FROM ci_installation_binding WHERE admin_managed LIMIT 1')
    if (binding) throw new Error('Retire administrator-managed CI authority before rollback')
    await runner.query('ALTER TABLE ci_installation_binding DROP COLUMN admin_managed')
  }
}
