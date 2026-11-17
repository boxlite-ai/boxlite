/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

const indexes = [
  ['ci_binding_organization_id_idx', ['organization_id', 'id']],
  ['ci_binding_account_login_idx', ['github_host', 'account_type', 'lower(account_login)', 'id']],
  ['ci_binding_account_id_idx', ['github_host', 'account_type', 'account_id', 'id']],
] as const

export class AddCiAdminIndexes1794873600001 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    const [settings] = await runner.query("SELECT current_setting('lock_timeout') AS lock_timeout")
    await runner.query("SET lock_timeout='2s'")
    try {
      for (const [name, keys] of indexes) {
        const [existing] = await runner.query(
          `SELECT i.indisvalid,i.indisunique,i.indnatts,i.indpred IS NULL AS unfiltered,am.amname,
          i.indrelid='ci_installation_binding'::regclass AS expected_table,
          ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,i.indnkeyatts) n) AS keys
          FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
          WHERE i.indexrelid=to_regclass($1)`,
          [name],
        )
        if (existing) {
          if (
            !existing.expected_table ||
            existing.amname !== 'btree' ||
            existing.indisunique ||
            !existing.unfiltered ||
            existing.indnatts !== keys.length ||
            JSON.stringify(existing.keys) !== JSON.stringify(keys)
          )
            throw new Error(`${name} exists with an unexpected definition`)
          if (existing.indisvalid) continue
          await runner.query(`DROP INDEX CONCURRENTLY ${name}`)
        }
        await runner.query(`CREATE INDEX CONCURRENTLY ${name} ON ci_installation_binding (${keys.join(',')})`)
      }
    } finally {
      await runner.query("SELECT set_config('lock_timeout',$1,false)", [settings.lock_timeout])
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    const [binding] = await runner.query('SELECT 1 FROM ci_installation_binding WHERE admin_managed LIMIT 1')
    if (binding) throw new Error('Retire administrator-managed CI authority before rollback')
    for (const [name] of [...indexes].reverse()) await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)
  }
}
