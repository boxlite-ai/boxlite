/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { MigrationInterface, QueryRunner } from 'typeorm'

const INDEX_NAME = 'box_creation_quota_idx'
const EXCLUDED_STATES = ['error', 'destroying', 'destroyed', 'archiving', 'archived']

type IndexTarget = {
  tableName: string
  indexName: string
  stateColumn: string
  stateType: string
  exists: boolean
  expectedShape: boolean | null
  valid: boolean | null
  predicate: string | null
}

export class AddBoxCreationQuotaIndex1795478400000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    const target = await this.inspectIndex(runner)
    if (target.exists) {
      if (target.valid) return
      // An interrupted concurrent build leaves an invalid index under the same name.
      await runner.query(`DROP INDEX CONCURRENTLY ${target.indexName}`)
    }
    await runner.query(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}
      ON ${target.tableName} USING btree ("organizationId")
      WHERE "state" NOT IN (${this.excludedStateLiterals(target.stateType).join(', ')})`)
  }

  async down(runner: QueryRunner): Promise<void> {
    const target = await this.inspectIndex(runner)
    if (target.exists) await runner.query(`DROP INDEX CONCURRENTLY ${target.indexName}`)
  }

  private excludedStateLiterals(stateType: string): string[] {
    return EXCLUDED_STATES.map((state) => `'${state}'::${stateType}`)
  }

  private async inspectIndex(runner: QueryRunner): Promise<IndexTarget> {
    const { options } = runner.connection
    const schema = 'schema' in options ? options.schema : undefined
    // PostgreSQL places indexes in the table's schema, even when another schema comes first in search_path.
    const [target]: IndexTarget[] = await runner.query(
      `SELECT format('%I.%I', ns.nspname, b.relname) AS "tableName",
        format('%I.%I', ns.nspname, $2::text) AS "indexName",
        quote_ident(state.attname) AS "stateColumn",
        format_type(state.atttypid, NULL) AS "stateType",
        c.oid IS NOT NULL AS "exists",
        i.indisvalid AS valid,
        c.relkind = 'i' AND i.indrelid = b.oid AND NOT i.indisunique AND NOT i.indisexclusion
          AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indkey[0] = org.attnum
          AND i.indoption[0] = 0 AND am.amname = 'btree'
          AND opc.opcnamespace = 'pg_catalog'::regnamespace AND opc.opcname = 'uuid_ops' AS "expectedShape",
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_class b
      JOIN pg_namespace ns ON ns.oid = b.relnamespace
      JOIN pg_attribute org ON org.attrelid = b.oid AND org.attname = 'organizationId' AND NOT org.attisdropped
      JOIN pg_attribute state ON state.attrelid = b.oid AND state.attname = 'state' AND NOT state.attisdropped
      JOIN pg_type state_type ON state_type.oid = state.atttypid AND state_type.typtype = 'e'
      LEFT JOIN pg_class c ON c.relnamespace = b.relnamespace AND c.relname = $2
      LEFT JOIN pg_index i ON i.indexrelid = c.oid
      LEFT JOIN pg_am am ON am.oid = c.relam
      LEFT JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      WHERE b.oid = to_regclass(CASE WHEN $1::text IS NULL THEN 'box' ELSE format('%I.box', $1) END)
        AND b.relkind = 'r'`,
      [schema ?? null, INDEX_NAME],
    )
    if (!target) throw new Error('Could not find the box table with its creation quota columns')

    // PostgreSQL deparses NOT IN as <> ALL using the session's identifier quoting and type visibility.
    const expectedPredicate = `(${target.stateColumn} <> ALL (ARRAY[${this.excludedStateLiterals(target.stateType).join(', ')}]))`
    if (target.exists && (!target.expectedShape || target.predicate !== expectedPredicate)) {
      throw new Error(`${target.indexName} exists with an unexpected definition`)
    }
    return target
  }
}
