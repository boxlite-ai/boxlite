import { randomUUID } from 'crypto'
import { DataSource } from 'typeorm'
import { AddRunnerMemoryIncidents1793836800000 } from '../../migrations/pre-deploy/1793836800000-add-runner-memory-incidents-migration'
import { RunnerMemoryIncidentDto } from './memory-incident.dto'
import { RunnerMemoryIncident } from './memory-incident.entity'
import { MemoryIncidentService } from './memory-incident.service'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `memory_incident_${process.pid}_${randomUUID().replaceAll('-', '')}`
const runnerId = '11111111-1111-4111-8111-111111111111'
const otherRunner = '22222222-2222-4222-8222-222222222222'
const range = { from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z', limit: 50 }
const report = (): RunnerMemoryIncidentDto => ({
  eventId: randomUUID(),
  sampledAt: range.from,
  runnerMemoryPercent: 80.000001,
  boxes: Array.from({ length: 5 }, (_, i) => ({
    boxId: `box-${i}`,
    image: `image:${i}`,
    memoryBytes: String(9007199254740993n - BigInt(i)),
  })),
  samplingComplete: true,
})

describeWithDatabase('Memory incident PostgreSQL persistence', () => {
  let db: DataSource
  let service: MemoryIncidentService
  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [RunnerMemoryIncident],
      migrations: [AddRunnerMemoryIncidents1793836800000],
      migrationsTransactionMode: 'each',
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.runMigrations()
    service = new MemoryIncidentService(db)
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.undoLastMigration()
      expect(await db.query(`SELECT to_regclass('${schema}.runner_memory_incident') AS name`)).toEqual([{ name: null }])
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE runner_memory_incident RESTART IDENTITY')
  })

  it('preserves five exact byte strings, ranking, images, and bigint ID precision', async () => {
    await db.query('ALTER TABLE runner_memory_incident ALTER COLUMN id RESTART WITH 9007199254740993')
    const first = report()
    await service.record(runnerId, first)
    const { items } = await service.list(range)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: '9007199254740993', runnerId, eventId: first.eventId, boxes: first.boxes })
    expect(items[0].sampledAt.toISOString()).toBe('2026-11-05T00:00:00.000Z')
  })

  it('deduplicates concurrent uploads and leaves all original rankings immutable on retry', async () => {
    const first = report()
    await Promise.all(Array.from({ length: 8 }, () => service.record(runnerId, first)))
    await service.record(runnerId, { ...first, boxes: [], samplingComplete: false })
    await service.record(otherRunner, first)
    const items = await db.getRepository(RunnerMemoryIncident).find({ order: { id: 'ASC' } })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ runnerId, boxes: first.boxes, samplingComplete: true })
    expect((await service.list({ ...range, runnerId })).items).toHaveLength(1)
  })

  it('retains empty, partial, and zero-usage snapshots without resource lookups', async () => {
    await service.record(runnerId, { ...report(), boxes: [], samplingComplete: false })
    await service.record(runnerId, { ...report(), boxes: [{ boxId: 'zero', image: '', memoryBytes: '0' }] })
    const { items } = await service.list(range)
    expect(items.map(({ boxes, samplingComplete }) => ({ boxes, samplingComplete }))).toEqual([
      { boxes: [], samplingComplete: false },
      { boxes: [{ boxId: 'zero', image: '', memoryBytes: '0' }], samplingComplete: true },
    ])
  })

  it('filters host sample time in [from,to), independently of receipt time, in ID order', async () => {
    const times = ['2026-11-05T00:00:00Z', '2026-11-05T00:01:00Z', '2026-11-05T00:02:00Z']
    for (const [index, sampledAt] of times.entries())
      await service.record(runnerId, {
        ...report(),
        sampledAt,
        boxes: [{ boxId: `box-${index}`, image: '', memoryBytes: '1' }],
      })
    const query = { ...range, to: times[2], runnerId }
    expect((await service.list(query)).items.map((item) => item.sampledAt.toISOString())).toEqual([
      '2026-11-05T00:00:00.000Z',
      '2026-11-05T00:01:00.000Z',
    ])
    expect((await service.list({ ...query, limit: 1 })).items).toHaveLength(1)
    expect((await service.list({ ...query, from: '2026-11-05T08:00:00+08:00' })).items).toHaveLength(2)
    expect(await service.list({ ...range, from: range.to, to: '2026-11-07T00:00:00Z' })).toEqual({ items: [] })
  })

  it('selects each box maximum before limiting and preserves the source snapshot metadata', async () => {
    const low = { ...report(), boxes: [{ boxId: 'a', image: 'old', memoryBytes: '9' }] }
    await service.record(runnerId, low)
    const first = {
      ...report(),
      boxes: [
        { boxId: 'a', image: 'a:max', memoryBytes: '10' },
        { boxId: 'b', image: 'b:old', memoryBytes: '8' },
        { boxId: 'c', image: 'c:max', memoryBytes: '7' },
      ],
    }
    await service.record(runnerId, first)
    const second = {
      ...report(),
      sampledAt: '2026-11-05T00:01:00Z',
      samplingComplete: false,
      boxes: [
        { boxId: 'b', image: 'b:max', memoryBytes: '11' },
        { boxId: 'a', image: 'a:tie', memoryBytes: '10' },
        { boxId: 'c', image: 'c:old', memoryBytes: '6' },
      ],
    }
    await service.record(otherRunner, second)
    const { items } = await service.list({ ...range, limit: 1 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: '2', eventId: first.eventId, boxes: [first.boxes[0], first.boxes[2]] })
    const all = (await service.list(range)).items
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({
      id: '3',
      runnerId: otherRunner,
      eventId: second.eventId,
      sampledAt: new Date(second.sampledAt),
      samplingComplete: false,
      boxes: [second.boxes[0]],
    })
    expect(all.flatMap(({ boxes }) => boxes.map(({ boxId }) => boxId))).toEqual(['a', 'c', 'b'])
    expect((await db.getRepository(RunnerMemoryIncident).findOneByOrFail({ eventId: first.eventId })).boxes).toEqual(
      first.boxes,
    )
  })

  it('selects exact byte maxima beyond safe integers with numeric row IDs breaking ties', async () => {
    await db.query('ALTER TABLE runner_memory_incident ALTER COLUMN id RESTART WITH 9007199254740993')
    await service.record(runnerId, {
      ...report(),
      boxes: [{ boxId: 'a', image: 'old', memoryBytes: '9007199254740992' }],
    })
    const winner = { ...report(), boxes: [{ boxId: 'a', image: 'max', memoryBytes: '9007199254740993' }] }
    await service.record(runnerId, winner)
    await service.record(otherRunner, { ...winner, boxes: [{ ...winner.boxes[0], image: 'tie' }] })
    const { items } = await service.list(range)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: '9007199254740994', eventId: winner.eventId, boxes: winner.boxes })
  })

  it('breaks equal-metric ties by numeric row ID across digit widths', async () => {
    await db.query('ALTER TABLE runner_memory_incident ALTER COLUMN id RESTART WITH 9')
    const winner = { ...report(), boxes: [{ boxId: 'a', image: 'winner', memoryBytes: '99' }] }
    await service.record(runnerId, winner)
    await db.query('ALTER TABLE runner_memory_incident ALTER COLUMN id RESTART WITH 10')
    await service.record(runnerId, { ...report(), boxes: [{ boxId: 'a', image: 'tied', memoryBytes: '99' }] })
    const { items } = await service.list({ ...range, limit: 50 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: '9', eventId: winner.eventId })
  })

  it('selects maxima only within the requested runner and time range', async () => {
    const single = (memoryBytes: string) => [{ boxId: 'a', image: '', memoryBytes }]
    await service.record(runnerId, { ...report(), boxes: single('1') })
    const winner = { ...report(), boxes: single('2') }
    await service.record(runnerId, winner)
    await service.record(otherRunner, { ...report(), boxes: single('3') })
    await service.record(runnerId, { ...report(), sampledAt: range.to, boxes: single('4') })
    const { items } = await service.list({ ...range, runnerId })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ eventId: winner.eventId, boxes: winner.boxes })
  })

  it('cancels a blocked ranking query within five seconds and restores the session timeout', async () => {
    const lock = db.createQueryRunner()
    await lock.connect()
    await lock.startTransaction()
    await lock.query('LOCK TABLE runner_memory_incident IN ACCESS EXCLUSIVE MODE')
    let timer: ReturnType<typeof setTimeout>
    const result = service.list({ ...range, limit: 50 }).then(
      () => 'completed',
      (error) => error.code,
    )
    try {
      const outcome = await Promise.race([
        result,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still blocked'), 7000)
        }),
      ])
      expect(outcome).toBe('57014')
      expect(await db.query("SELECT current_setting('statement_timeout') AS timeout")).toEqual([{ timeout: '0' }])
    } finally {
      clearTimeout(timer)
      await lock.rollbackTransaction()
      await lock.release()
      await result
    }
  }, 10000)

  it.each([
    { runnerMemoryPercent: 80 },
    { runnerMemoryPercent: 101 },
    { runnerMemoryPercent: Number.NaN },
    { boxes: Array.from({ length: 6 }, () => report().boxes[0]) },
    { boxes: {} as never },
  ])('enforces database threshold and bounded snapshot shape %j', async (extra) => {
    const value = { ...report(), ...extra }
    await expect(
      db.getRepository(RunnerMemoryIncident).insert({ ...value, runnerId, sampledAt: new Date(value.sampledAt) }),
    ).rejects.toThrow()
    expect(await db.getRepository(RunnerMemoryIncident).count()).toBe(0)
  })
})
