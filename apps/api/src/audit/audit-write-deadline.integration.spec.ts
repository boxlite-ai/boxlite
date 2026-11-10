import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DataSource } from 'typeorm'
import { AuditLog } from './entities/audit-log.entity'
import { AuditAction } from './enums/audit-action.enum'
import { AuditService } from './services/audit.service'
import { AuditLogSubscriber } from './subscribers/audit-log.subscriber'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip

databaseSuite('audit write deadlines on PostgreSQL', () => {
  let db: DataSource
  let observer: DataSource
  let service: AuditService
  let schema: string
  const dto = { actorId: 'actor', actorEmail: '', action: AuditAction.ATTACH }

  beforeEach(async () => {
    schema = `deadline_${randomUUID().replaceAll('-', '')}`
    const options = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    }
    observer = await new DataSource(options).initialize()
    await observer.query(`CREATE SCHEMA "${schema}"`)
    db = await new DataSource({
      ...options,
      schema,
      entities: [AuditLog],
      entitySkipConstructor: true,
      extra: { max: 1, options: `-c search_path=${schema},public`, application_name: schema },
    }).initialize()
    await db.synchronize()
    new AuditLogSubscriber(db)
    service = new AuditService(
      db.getRepository(AuditLog),
      { get: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
    )
  })

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy()
    if (observer?.isInitialized) {
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`)
      await observer.destroy()
    }
  })

  it('times out while the pool is full and never writes after a late acquisition', async () => {
    const held = db.createQueryRunner()
    await held.connect()
    let outcome = 'pending'
    const write = service.createLog(dto, 100).then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await Promise.race([write, delay(500)])
      expect(outcome).toBe('failed')
    } finally {
      await held.release()
      await write
    }
    // The single pool connection passes through the late waiter before this query.
    expect(await db.getRepository(AuditLog).count()).toBe(0)
    await expect(service.createLog(dto, 1000)).resolves.toMatchObject(dto)
  })

  it('stops a slow statement on the server and recovers a single-connection pool', async () => {
    await db.query(`CREATE FUNCTION slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$`)
    await db.query('CREATE TRIGGER slow_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION slow_audit()')
    let outcome = 'pending'
    const write = service.createLog(dto, 300).then(
      () => {
        outcome = 'success'
      },
      () => {
        outcome = 'failed'
      },
    )
    try {
      await Promise.race([write, delay(1000)])
      expect(outcome).toBe('failed')
      const stopBy = Date.now() + 1000
      let active: number
      do {
        const [state] = await observer.query(
          "SELECT count(*)::int AS active FROM pg_stat_activity WHERE application_name = $1 AND state <> 'idle'",
          [schema],
        )
        active = state.active
        if (!active) break
        await delay(10)
      } while (Date.now() < stopBy)
      expect(active).toBe(0)
      expect(
        await observer.query(
          `SELECT count(*)::int AS locks FROM pg_locks WHERE relation = '"${schema}".audit_log'::regclass`,
        ),
      ).toEqual([{ locks: 0 }])
    } finally {
      // Also terminates the baseline's unbounded query during defect proof.
      await observer.query(
        'SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND state <> $2',
        [schema, 'idle'],
      )
      await write
    }
    await db.query('DROP TRIGGER slow_audit ON audit_log')
    expect(await db.getRepository(AuditLog).count()).toBe(0)
    await expect(service.createLog(dto, 1000)).resolves.toMatchObject(dto)
  })

  it('commits bounded writes with subscribers and restores transaction-local timeouts', async () => {
    const row = await service.createLog({ ...dto, metadata: { connectionId: 'connection' } }, 1000)
    await expect(
      service.updateLog(row.id, { statusCode: 101, metadata: { connectedAt: 'now' } }, 1000),
    ).resolves.toMatchObject({ statusCode: 101, metadata: { connectionId: 'connection', connectedAt: 'now' } })
    await expect(service.updateLog(row.id, { statusCode: 0 }, 1000)).rejects.toThrow('immutable')
    expect(await db.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '0' }])
    expect(await db.query('SHOW lock_timeout')).toEqual([{ lock_timeout: '0' }])
  })
})
