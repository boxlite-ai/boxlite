import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { createHash } from 'crypto'
import { isUUID } from 'class-validator'
import { DataSource, EntityManager } from 'typeorm'

export type BindBoxRequest = (manager: EntityManager, boxId: string) => Promise<void>
export const IDEMPOTENCY_KEY_LIFETIME = 'PT24H'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Recover a request's resource before repeating any creation work. The resource
 * association commits in the Box repository's transaction; the response may be
 * completed later by another API process after a crash or startup timeout. */
@Injectable()
export class BoxRequestService implements OnModuleDestroy {
  private locks: Promise<DataSource> | undefined
  private active = 0

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleDestroy(): Promise<void> {
    if (this.locks) await (await this.locks).destroy()
  }

  private lockDatabase(): Promise<DataSource> {
    // Never reserve application-pool connections while a callback needs its
    // own transaction. Bound admission before checkout, including initialization.
    const options = this.dataSource.options
    if (options.type !== 'postgres') throw new Error('Box request persistence requires PostgreSQL')
    if (this.locks) return this.locks
    const initializing = new DataSource({
      ...options,
      poolSize: 4,
      extra: { ...this.dataSource.options.extra, max: 4 },
      migrationsRun: false,
      synchronize: false,
    }).initialize()
    this.locks = initializing
    void initializing.catch(() => {
      if (this.locks === initializing) this.locks = undefined
    })
    return initializing
  }

  async run<T>(
    scope: string[],
    key: string,
    payload: unknown,
    create: (bind: BindBoxRequest, boxId?: string, associate?: (id: string) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    if (!isUUID(key)) throw new BadRequestException('Idempotency-Key must be a UUID')
    const identity = JSON.stringify([...scope, key.toLowerCase()])
    const hash = createHash('sha256').update(canonical(payload)).digest('hex')
    if (this.active >= 4) throw new ServiceUnavailableException('Request recovery is busy; retry shortly')
    this.active++
    let connection: ReturnType<DataSource['createQueryRunner']>
    let locked = false
    try {
      connection = (await this.lockDatabase()).createQueryRunner()
      await connection.connect()
      // Transaction locks skip requests currently owned by any API instance.
      // Each call bounds cleanup work, including keys never presented again.
      await connection.query(`WITH candidates AS MATERIALIZED (
        SELECT scope FROM box_request WHERE "expiresAt" <= now() ORDER BY "expiresAt" LIMIT 100
      ) DELETE FROM box_request WHERE scope IN (
        SELECT scope FROM candidates WHERE pg_try_advisory_xact_lock(hashtextextended(scope, 0))
      )`)
      const [lock] = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [
        identity,
      ])
      locked = lock.acquired
      if (!locked) throw new ConflictException('This Idempotency-Key is in progress; retry the request')
      await connection.query('DELETE FROM box_request WHERE scope = $1 AND "expiresAt" <= now()', [identity])
      let [record] = await connection.query('SELECT * FROM box_request WHERE scope = $1', [identity])
      if (record && record.hash !== hash)
        throw new UnprocessableEntityException('Idempotency-Key was used with a different request')
      if (record?.response) return record.response
      if (!record) {
        ;[record] = await connection.query('INSERT INTO box_request (scope, hash) VALUES ($1, $2) RETURNING *', [
          identity,
          hash,
        ])
      }
      const bind: BindBoxRequest = async (manager, boxId) => {
        const rows = await manager.query(
          'UPDATE box_request SET "boxId" = $2 WHERE scope = $1 AND token = $3 AND ("boxId" IS NULL OR "boxId" = $2) RETURNING scope',
          [identity, boxId, record.token],
        )
        if (rows[1] !== 1) throw new ConflictException('Request ownership changed; retry the request')
      }
      const response = await create(bind, record.boxId ?? undefined, async (id) => {
        await bind(connection.manager, id)
        // The deadline travels with the random token so delayed RPCs cannot
        // restart an execution after the guest safely forgets its request.
        return `${record.token}.${new Date(record.expiresAt).getTime()}`
      })
      await connection.query('UPDATE box_request SET response = $2 WHERE scope = $1 AND token = $3', [
        identity,
        response,
        record.token,
      ])
      return response
    } catch (error) {
      // A refusal before resource association has no effects to recover. Do not
      // freeze a quota failure or keep unused keys indefinitely.
      if (locked)
        await connection.query('DELETE FROM box_request WHERE scope = $1 AND "boxId" IS NULL AND response IS NULL', [
          identity,
        ])
      throw error
    } finally {
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [identity])
      } finally {
        try {
          if (connection) await connection.release()
        } finally {
          this.active--
        }
      }
    }
  }
}
