/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager, QueryFailedError } from 'typeorm'
import { ExecutionLease, LeaseLost, postgresStateTable } from '@boxlite-ai/ci-listener'
import { CiNativeState } from './ci-native-state'

const integration = process.env.DB_HOST ? describe : describe.skip
integration('CI native state snapshot conflicts', () => {
  const schema = 'ci_snapshot_' + randomUUID().replaceAll('-', '')
  let db: DataSource, store: CiNativeState, lease: ExecutionLease
  let snapshots: number

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
      throw Error('Disposable local PostgreSQL required')
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(postgresStateTable)
  })
  afterAll(async () => {
    if (db?.isInitialized)
      try {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE ci_listener_state')
    store = new CiNativeState(db, {
      get: (key: string) => (key === 'ci.githubClientId' ? 'test-app' : undefined),
    } as any)
    await store.initialize()
    lease = (await store.state.acquire('listener', 30000))!
    await store.state.ingest([{ key: 'notice/job', expected: null, payload: { job: 42 } }])
    snapshots = 0
  })
  afterEach(() => jest.restoreAllMocks())

  // Run the competing transaction after PostgreSQL fixes the snapshot, but
  // before the production lease check locks @owner. No timing sleeps decide order.
  function afterAnchor(interleave: (attempt: number, tx: EntityManager) => Promise<void>) {
    const transaction = db.transaction.bind(db)
    jest.spyOn(db, 'transaction').mockImplementation((async (isolation: any, work: any) => {
      if (isolation !== 'REPEATABLE READ') return transaction(isolation, work)
      const attempt = ++snapshots
      return transaction(isolation, async (tx: EntityManager) => {
        const query = tx.query.bind(tx)
        let anchored = false
        jest.spyOn(tx, 'query').mockImplementation(async (sql, parameters) => {
          const result = await query(sql, parameters)
          if (!anchored && parameters?.[1] === '@anchor') {
            anchored = true
            await interleave(attempt, tx)
          }
          return result
        })
        return work(tx)
      })
    }) as any)
  }

  it.each(['read', 'recover', 'scan'] as const)(
    'completes %s during renewal without restarting its snapshot',
    async (operation) => {
      const expected = await store.state.read(['notice/job'], lease)
      afterAnchor(async (attempt) => {
        if (attempt === 1) await store.state.renew(lease, 30000)
      })
      const result =
        operation === 'read'
          ? store.state.read(['notice/job'], lease)
          : operation === 'recover'
            ? store.state.recover(lease, 100, ['notice/'])
            : store.state.scan(lease, { prefix: 'notice/' })
      await expect(result).resolves.toEqual(expected)
      expect(snapshots).toBe(1)
    },
  )

  it('rejects the previous scheduler after takeover', async () => {
    await db.query(
      "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'),lease_until=to_timestamp(0) WHERE namespace=$1 AND record_key='@lease'",
      [store.namespace],
    )
    expect(await store.state.acquire('successor', 30000)).toBeDefined()
    await expect(store.state.read(['notice/job'], lease)).rejects.toBeInstanceOf(LeaseLost)
    await expect(store.state.renew(lease, 30000)).rejects.toBeInstanceOf(LeaseLost)
  })

  it('allows renewal before a borrowed snapshot locks the owner', async () => {
    const expected = await store.state.read(['notice/job'], lease)
    afterAnchor(() => store.state.renew(lease, 30000))
    await expect(
      db.transaction('REPEATABLE READ', (tx) => store.inside(tx).read(['notice/job'], lease)),
    ).resolves.toEqual(expected)
    expect(snapshots).toBe(1)
  })

  it('does not retry a snapshot invalidated by actual takeover', async () => {
    afterAnchor(async () => {
      await db.query(
        "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0') WHERE namespace=$1 AND record_key='@lease'",
        [store.namespace],
      )
      expect(await store.state.acquire('successor', 30000)).toBeDefined()
    })
    await expect(store.state.read(['notice/job'], lease)).rejects.toMatchObject({ driverError: { code: '40001' } })
    expect(snapshots).toBe(1)
  })

  it('does not retry other PostgreSQL errors', async () => {
    afterAnchor(async (_attempt, tx) => {
      await tx.query('SELECT 1/0')
    })
    await expect(store.state.read(['notice/job'], lease)).rejects.toMatchObject({ driverError: { code: '22012' } })
    expect(snapshots).toBe(1)
  })

  it.each(['read', 'renew'])('does not replay a failed %s transaction', async (operation) => {
    const failure = new QueryFailedError(
      'SELECT',
      [],
      Object.assign(new Error('serialization failure'), { code: '40001' }),
    )
    const transaction = jest.spyOn(db, 'transaction').mockRejectedValue(failure)
    const pending = operation === 'read' ? store.state.read(['notice/job'], lease) : store.state.renew(lease, 30000)
    await expect(pending).rejects.toBe(failure)
    expect(transaction).toHaveBeenCalledTimes(1)
  })
})
