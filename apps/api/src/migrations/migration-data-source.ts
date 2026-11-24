import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from 'pg'
import { CannotExecuteNotConnectedError, DataSource, Migration, MigrationExecutor, QueryRunner } from 'typeorm'

type MigrationOptions = Parameters<DataSource['runMigrations']>[0]
type TransactionMode = MigrationExecutor['transaction']
type MigrationSession = Pick<Client, 'end'>

const LOCK_NAMESPACE = 'boxlite:typeorm:migrations'
const LOCK_WAIT_MS = 90_000
const LOCK_POLL_MS = 250

export class MigrationLockTimeoutError extends Error {
  constructor() {
    super(`Timed out after ${LOCK_WAIT_MS / 1000} seconds waiting for the BoxLite migration lock`)
    this.name = 'MigrationLockTimeoutError'
  }
}

async function acquireMigrationLock(runner: QueryRunner): Promise<void> {
  const deadline = performance.now() + LOCK_WAIT_MS
  // A blocking advisory-lock statement can retain a snapshot needed by CREATE INDEX CONCURRENTLY.
  while (performance.now() < deadline) {
    const [row] = await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [
      LOCK_NAMESPACE,
    ])
    if (row.acquired) return
    await delay(Math.min(LOCK_POLL_MS, Math.max(0, deadline - performance.now())))
  }
  throw new MigrationLockTimeoutError()
}

async function releaseMigrationLock(runner: QueryRunner): Promise<void> {
  const [row] = await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [LOCK_NAMESPACE])
  if (!row.released) throw new Error('BoxLite migration lock release could not be confirmed')
}

async function closeUncertainSession(client: MigrationSession, error: unknown): Promise<never> {
  try {
    await client.end()
  } catch (closeError) {
    throw new AggregateError([error, closeError], 'Could not close the BoxLite migration session')
  }
  throw error
}

export class MigrationDataSource extends DataSource {
  override runMigrations(options?: MigrationOptions): Promise<Migration[]> {
    return this.withLockedExecutor(options, this.options.migrationsTransactionMode || 'all', (executor) =>
      executor.executePendingMigrations(),
    )
  }

  runBundledMigrations(): Promise<Migration[]> {
    return this.withLockedExecutor(undefined, 'all', async (executor) => {
      const pending = await executor.getPendingMigrations()
      if (pending.some(({ instance }) => instance?.transaction !== undefined)) executor.transaction = 'each'
      return executor.executePendingMigrations()
    })
  }

  override undoLastMigration(options?: MigrationOptions): Promise<void> {
    return this.withLockedExecutor(options, 'all', (executor) => executor.undoLastMigration())
  }

  private async withLockedExecutor<T>(
    options: MigrationOptions,
    defaultMode: TransactionMode,
    execute: (executor: MigrationExecutor) => Promise<T>,
  ): Promise<T> {
    if (!this.isInitialized) throw new CannotExecuteNotConnectedError(this.name)
    const runner = this.createQueryRunner()
    try {
      const client: MigrationSession = await runner.connect()
      try {
        await acquireMigrationLock(runner)
      } catch (error) {
        // The server may have acquired the lock before a failed response reached the client.
        await closeUncertainSession(client, error)
      }

      const executor = new MigrationExecutor(this, runner)
      executor.transaction = options?.transaction ?? defaultMode
      executor.fake = options?.fake ?? false
      let migrationError: unknown
      try {
        return await execute(executor)
      } catch (error) {
        migrationError = error
        throw error
      } finally {
        try {
          await releaseMigrationLock(runner)
        } catch (error) {
          await closeUncertainSession(
            client,
            migrationError ? new AggregateError([migrationError, error], 'BoxLite migration and unlock failed') : error,
          )
        }
      }
    } finally {
      await runner.release()
    }
  }
}
