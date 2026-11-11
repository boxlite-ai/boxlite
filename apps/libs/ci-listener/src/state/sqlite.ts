/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateDatabase, StateRecord, StateTransaction } from './database'

const queues = new Map<string, Promise<void>>()
type Row = { record_key: string; record_version: string; schema_version: number; payload: string }
const decode = (row: Row): StateRecord => ({
  key: row.record_key,
  version: row.record_version,
  schema: row.schema_version,
  payload: JSON.parse(row.payload),
})

/** Local image adapter for Node 24. Files remain under a private, non-symlink directory. */
export class SqliteStateDatabase implements StateDatabase {
  private readonly file: string
  private readonly database: DatabaseSync
  private closed = false
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.privatePath(directory, true)
    this.file = join(realpathSync(directory), 'listener.sqlite')
    try {
      closeSync(
        openSync(this.file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.privatePath(this.file, false)
    this.database = new DatabaseSync(this.file)
    try {
      this.database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS ci_listener_state (
          namespace TEXT NOT NULL, record_key TEXT COLLATE BINARY NOT NULL,
          record_version TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>0),
          owner_epoch INTEGER, owner_id TEXT, lease_until INTEGER,
          payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(namespace,record_key))`)
      this.sidecars()
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  transaction<T>(namespace: string, work: (tx: StateTransaction) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.closed) throw new Error('Listener database is closed')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const result = await work(new SqliteTransaction(this.database, namespace))
        this.sidecars()
        this.database.exec('COMMIT')
        return result
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    })
  }
  async close(): Promise<void> {
    await this.serial(async () => {
      if (!this.closed) {
        this.database.close()
        this.closed = true
      }
    })
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    // Separate connections in the same event loop must not block each other's pending commit.
    const previous = queues.get(this.file) ?? Promise.resolve(),
      current = previous.then(work)
    const tail = current.then(
      () => undefined,
      () => undefined,
    )
    queues.set(this.file, tail)
    try {
      return await current
    } finally {
      if (queues.get(this.file) === tail) queues.delete(this.file)
    }
  }
  private sidecars(): void {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(this.file + suffix)) this.privatePath(this.file + suffix, false)
  }
  private privatePath(path: string, directory: boolean): void {
    const stat = lstatSync(path),
      uid = process.getuid?.()
    if (
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    )
      throw new Error('Listener state requires private owned files and directory')
  }
}

class SqliteTransaction implements StateTransaction {
  constructor(
    private readonly database: DatabaseSync,
    private readonly namespace: string,
  ) {}
  async now(): Promise<number> {
    return Date.now()
  }
  async get(key: string): Promise<StateRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM ci_listener_state WHERE namespace=? AND record_key=?')
      .get(this.namespace, key) as Row | undefined
    return row ? decode(row) : undefined
  }
  async page(after: string, limit: number, prefix = ''): Promise<StateRecord[]> {
    return (
      this.database
        .prepare(
          'SELECT * FROM ci_listener_state WHERE namespace=? AND record_key>? AND record_key>=? AND record_key<? ORDER BY record_key LIMIT ?',
        )
        .all(this.namespace, after, prefix, prefix + '\x7f', limit) as Row[]
    ).map(decode)
  }
  async put(record: StateRecord, expected: string | null): Promise<boolean> {
    const owner =
      record.key === '@owner' ? (record.payload as { owner: string; epoch: number; until: number }) : undefined
    if (expected === null)
      return (
        this.database
          .prepare(
            `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload,owner_epoch,owner_id,lease_until,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
          )
          .run(
            this.namespace,
            record.key,
            record.version,
            record.schema,
            JSON.stringify(record.payload),
            owner?.epoch ?? null,
            owner?.owner ?? null,
            owner?.until ?? null,
            Date.now(),
          ).changes === 1
      )
    return (
      this.database
        .prepare(
          `UPDATE ci_listener_state SET record_version=?,schema_version=?,payload=?,owner_epoch=?,owner_id=?,lease_until=?,updated_at=? WHERE namespace=? AND record_key=? AND record_version=?`,
        )
        .run(
          record.version,
          record.schema,
          JSON.stringify(record.payload),
          owner?.epoch ?? null,
          owner?.owner ?? null,
          owner?.until ?? null,
          Date.now(),
          this.namespace,
          record.key,
          expected,
        ).changes === 1
    )
  }
  async remove(key: string, expected: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM ci_listener_state WHERE namespace=? AND record_key=? AND record_version=?')
        .run(this.namespace, key, expected).changes === 1
    )
  }
}
