/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Json, StateDatabase, StateRecord, StateTransaction } from './database'

export const postgresStateTable = `CREATE TABLE ci_listener_state (
  namespace text NOT NULL, record_key text COLLATE "C" NOT NULL,
  record_version uuid NOT NULL, schema_version integer NOT NULL CHECK(schema_version > 0),
  owner_epoch bigint NULL, owner_id text NULL, lease_until timestamptz NULL,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace,record_key))`

interface SqlSession {
  query(sql: string, parameters?: unknown[]): Promise<unknown>
}
export interface PostgresConnection {
  transaction<T>(isolation: 'READ COMMITTED' | 'REPEATABLE READ', work: (session: SqlSession) => Promise<T>): Promise<T>
}
type Row = { record_key: string; record_version: string; schema_version: number; payload: Json }
const decode = (row: Row): StateRecord => ({
  key: row.record_key,
  version: row.record_version,
  schema: row.schema_version,
  payload: row.payload,
})

/** Reuses the host's connection pool; owns no ORM, environment or database lifecycle. */
export class PostgresStateDatabase implements StateDatabase {
  constructor(private readonly connection: PostgresConnection) {}
  transaction<T>(
    namespace: string,
    work: (tx: StateTransaction) => Promise<T>,
    mode: 'write' | 'bootstrap' | 'snapshot' = 'write',
  ): Promise<T> {
    return this.connection.transaction(mode === 'snapshot' ? 'REPEATABLE READ' : 'READ COMMITTED', async (session) => {
      // Only initial root creation needs to serialize an absent owner row.
      if (mode === 'bootstrap')
        await session.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ci-listener:' + namespace])
      return work(new PostgresTransaction(session, namespace))
    })
  }
}

class PostgresTransaction implements StateTransaction {
  constructor(
    private readonly session: SqlSession,
    private readonly namespace: string,
  ) {}
  private async rows(sql: string, parameters: unknown[]): Promise<Row[]> {
    return (await this.session.query(sql, parameters)) as Row[]
  }
  async now(): Promise<number> {
    const rows = (await this.session.query(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS value',
    )) as { value: string }[]
    return Number(rows[0].value)
  }
  async get(key: string, lock = false): Promise<StateRecord | undefined> {
    const rows = await this.rows(
      'SELECT * FROM ci_listener_state WHERE namespace=$1 AND record_key=$2' + (lock ? ' FOR UPDATE' : ''),
      [this.namespace, key],
    )
    return rows[0] ? decode(rows[0]) : undefined
  }
  async page(after: string, limit: number, prefix = '', lock?: 'skip-locked'): Promise<StateRecord[]> {
    return (
      await this.rows(
        'SELECT * FROM ci_listener_state WHERE namespace=$1 AND record_key>$2 AND record_key>=$3 AND record_key<$4 ORDER BY record_key LIMIT $5' +
          (lock ? ' FOR UPDATE SKIP LOCKED' : ''),
        [this.namespace, after, prefix, prefix + '\x7f', limit],
      )
    ).map(decode)
  }
  async put(record: StateRecord, expected: string | null): Promise<boolean> {
    const owner = record.key === '@owner' ? (record.payload as { owner: string; epoch: number }) : undefined
    const until = record.key === '@lease' ? (record.payload as { until: number }).until : undefined
    const values = [
      this.namespace,
      record.key,
      record.version,
      record.schema,
      JSON.stringify(record.payload),
      owner?.epoch ?? null,
      owner?.owner ?? null,
      until === undefined ? null : new Date(until),
    ]
    const sql =
      expected === null
        ? `WITH changed AS (INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload,owner_epoch,owner_id,lease_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING record_key) SELECT * FROM changed`
        : `WITH changed AS (UPDATE ci_listener_state SET record_version=$3,schema_version=$4,payload=$5,owner_epoch=$6,owner_id=$7,lease_until=$8,updated_at=clock_timestamp()
          WHERE namespace=$1 AND record_key=$2 AND record_version=$9 RETURNING record_key) SELECT * FROM changed`
    if (expected !== null) values.push(expected)
    return (await this.rows(sql, values)).length === 1
  }
  async remove(key: string, expected: string): Promise<boolean> {
    return (
      (
        await this.rows(
          `WITH changed AS (DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key=$2 AND record_version=$3 RETURNING record_key) SELECT * FROM changed`,
          [this.namespace, key, expected],
        )
      ).length === 1
    )
  }
}
