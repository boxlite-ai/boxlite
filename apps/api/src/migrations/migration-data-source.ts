// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { setTimeout } from 'node:timers/promises'
import type { Client, QueryResultRow } from 'pg'
import { CannotExecuteNotConnectedError, DataSource, MigrationExecutor, QueryRunner } from 'typeorm'

const LOCK_NAME = 'boxlite:typeorm:migrations'
const LOCK_POLL_MS = 250
const LOCK_WAIT_MS = 5 * 60_000
const LOCK_QUERY_MS = 5_000

type MigrationOptions = Parameters<DataSource['runMigrations']>[0]
type MigrationSession = Pick<Client, 'query' | 'end'>

function lockQueryBudget(deadline: number) {
  const remaining = Math.ceil(deadline - performance.now())
  if (remaining <= 0) throw new Error('Timed out waiting for PostgreSQL migration lock queries')
  return Math.min(LOCK_QUERY_MS, remaining)
}

function timedQuery<T extends QueryResultRow>(
  session: MigrationSession,
  deadline: number,
  text: string,
  values: string[] = [],
) {
  const query = { text, values, query_timeout: lockQueryBudget(deadline) }
  return session.query<T>(query)
}

async function withLockQueryTimeout(
  session: MigrationSession,
  deadline: number,
  execute: (lockQuery: (sql: string) => Promise<boolean>) => Promise<void>,
) {
  const setting = "SELECT set_config('statement_timeout', $1, false)"
  const {
    rows: [previous],
  } = await timedQuery<{ timeout: number }>(
    session,
    deadline,
    "SELECT setting::int AS timeout FROM pg_settings WHERE name = 'statement_timeout'",
  )

  await execute(async (sql) => {
    const limit = Math.min(lockQueryBudget(deadline), previous.timeout || LOCK_QUERY_MS)
    await timedQuery(session, deadline, setting, [`${limit}ms`])
    const {
      rows: [result],
    } = await timedQuery<{ acquired: boolean }>(session, deadline, sql, [LOCK_NAME])
    return result.acquired
  })
  // DDL and other users of this pooled connection retain their configured timeout.
  await timedQuery(session, deadline, setting, [`${previous.timeout}ms`])
}

async function discardMigrationSession(session: MigrationSession, error: unknown) {
  try {
    await session.end()
  } catch (closeError) {
    return new AggregateError([error, closeError], 'Could not close the PostgreSQL migration session')
  }
  return error
}

export class MigrationDataSource extends DataSource {
  override runMigrations(options?: MigrationOptions) {
    return this.withMigrationLock(async (executor, runner) => {
      await this.assertCompleteOutboundSchema(executor, runner)
      executor.transaction = options?.transaction ?? this.options.migrationsTransactionMode ?? 'all'
      executor.fake = options?.fake ?? false
      return executor.executePendingMigrations()
    })
  }

  override undoLastMigration(options?: MigrationOptions) {
    return this.withMigrationLock(async (executor, runner) => {
      await this.assertCompleteOutboundSchema(executor, runner)
      executor.transaction = options?.transaction ?? 'all'
      executor.fake = options?.fake ?? false
      return executor.undoLastMigration()
    })
  }

  override showMigrations() {
    // TypeORM creates the migrations table if the journal is absent.
    return this.withMigrationLock((executor) => executor.showMigrations())
  }

  private async assertCompleteOutboundSchema(executor: MigrationExecutor, runner: QueryRunner): Promise<void> {
    if (!(await executor.getAllMigrations()).some((migration) => migration.timestamp === 1795096806000)) return

    const executed = await executor.getExecutedMigrations()
    const [obsolete] = await runner.query(
      `SELECT EXISTS (
        SELECT 1 FROM pg_class relation JOIN pg_namespace scope ON scope.oid = relation.relnamespace
        WHERE scope.nspname = COALESCE($1, current_schema()) AND relation.relname = 'complete_outbound_admission'
      ) OR EXISTS (
        SELECT 1 FROM pg_proc fn JOIN pg_namespace scope ON scope.oid = fn.pronamespace
        WHERE scope.nspname = COALESCE($1, current_schema()) AND (
          fn.proname IN ('complete_outbound_activate', 'complete_outbound_close', 'complete_outbound_begin_downgrade')
          OR (fn.proname = 'complete_outbound_protect_owned_lease' AND fn.prosrc LIKE '%complete_outbound_admission%')
        )
      ) AS present`,
      [this.driver.schema ?? null],
    )
    if (obsolete.present || executed.some((migration) => migration.timestamp === 1795096802000)) {
      throw new Error(
        'Restore the complete outbound migration baseline with its matching release before applying or reverting migrations',
      )
    }
  }

  private async withMigrationLock<T>(
    execute: (executor: MigrationExecutor, runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    if (!this.isInitialized) throw new CannotExecuteNotConnectedError(this.name)

    const runner = this.createQueryRunner('master')
    try {
      const session: MigrationSession = await runner.connect()
      const deadline = performance.now() + LOCK_WAIT_MS
      try {
        await withLockQueryTimeout(session, deadline, async (query) => {
          // A blocking lock query can hold a snapshot needed by CREATE INDEX CONCURRENTLY.
          while (!(await query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired'))) {
            await setTimeout(Math.min(LOCK_POLL_MS, lockQueryBudget(deadline)))
          }
        })
      } catch (error) {
        // The server can acquire the lock before a timed-out response reaches the client.
        throw await discardMigrationSession(session, error)
      }

      try {
        return await execute(new MigrationExecutor(this, runner), runner)
      } finally {
        try {
          await withLockQueryTimeout(session, performance.now() + LOCK_QUERY_MS, async (query) => {
            if (!(await query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS acquired'))) {
              throw new Error('PostgreSQL migration lock release could not be confirmed')
            }
          })
        } catch (error) {
          const failure = await discardMigrationSession(session, error)
          // A retry following a committed revert would target the preceding migration.
          console.warn(`PostgreSQL migration lock cleanup failed: ${String(failure)}`)
        }
      }
    } finally {
      await runner.release()
    }
  }
}
