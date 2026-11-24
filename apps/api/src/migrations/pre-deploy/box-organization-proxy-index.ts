import type { QueryRunner } from 'typeorm'

const INDEX = 'box_organization_id_proxy_idx'

async function readIndex(runner: QueryRunner) {
  const [index] = await runner.query(
    `SELECT format('%I.%I', schema.nspname, box.relname) AS "boxName",
      format('%I.%I', schema.nspname, $1::text) AS "indexName",
      named.oid IS NOT NULL AS present,
      COALESCE(i.indrelid = box.oid AND method.amname = 'btree'
        AND i.indisunique AND i.indimmediate
        AND i.indnkeyatts = 2 AND i.indnatts = 2
        AND i.indkey::text = concat(org.attnum, ' ', box_id.attnum)
        AND i.indcollation[0] = org.attcollation AND i.indcollation[1] = box_id.attcollation
        AND i.indoption::text = '0 0'
        AND org_ops.opcdefault AND id_ops.opcdefault
        AND i.indpred IS NULL AND i.indexprs IS NULL, false) AS matches,
      COALESCE(i.indisvalid AND i.indisready AND i.indislive, false) AS usable
    FROM pg_class box
    JOIN pg_namespace schema ON schema.oid = box.relnamespace
    JOIN pg_attribute org ON org.attrelid = box.oid AND org.attname = 'organizationId'
    JOIN pg_attribute box_id ON box_id.attrelid = box.oid AND box_id.attname = 'id'
    LEFT JOIN pg_class named ON named.relnamespace = schema.oid AND named.relname = $1
    LEFT JOIN pg_index i ON i.indexrelid = named.oid
    LEFT JOIN pg_am method ON method.oid = named.relam
    LEFT JOIN pg_opclass org_ops ON org_ops.oid = i.indclass[0]
    LEFT JOIN pg_opclass id_ops ON id_ops.oid = i.indclass[1]
    WHERE box.oid = 'box'::regclass`,
    [INDEX],
  )
  if (!index) throw new Error('Could not find the Box table columns for the outbound proxy index')
  return index as { boxName: string; indexName: string; present: boolean; matches: boolean; usable: boolean }
}

export async function ensureBoxOrganizationProxyIndex(runner: QueryRunner): Promise<void> {
  const index = await readIndex(runner)
  if (index.present && !index.matches) {
    throw new Error(
      `Unexpected definition of ${index.indexName}; expected an immediate unique index on (organizationId, id)`,
    )
  }
  if (index.usable) return

  if (index.present) await runner.query(`DROP INDEX CONCURRENTLY ${index.indexName}`)
  await runner.query(`CREATE UNIQUE INDEX CONCURRENTLY ${INDEX} ON ${index.boxName} ("organizationId", id)`)
  const created = await readIndex(runner)
  if (!created.matches || !created.usable) throw new Error(`Outbound proxy index ${index.indexName} is not usable`)
}

export async function dropBoxOrganizationProxyIndex(runner: QueryRunner): Promise<void> {
  const index = await readIndex(runner)
  if (index.present && !index.matches) throw new Error(`Unexpected definition of ${index.indexName}`)
  await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.indexName}`)
}
