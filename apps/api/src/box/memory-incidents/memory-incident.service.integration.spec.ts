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
    const { items } = await service.list(range)
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
    for (const sampledAt of times) await service.record(runnerId, { ...report(), sampledAt })
    const query = { ...range, to: times[2], runnerId }
    expect((await service.list(query)).items.map((item) => item.sampledAt.toISOString())).toEqual([
      '2026-11-05T00:00:00.000Z',
      '2026-11-05T00:01:00.000Z',
    ])
    expect((await service.list({ ...query, limit: 1 })).items).toHaveLength(1)
    expect((await service.list({ ...query, from: '2026-11-05T08:00:00+08:00' })).items).toHaveLength(2)
    expect(await service.list({ ...range, from: range.to, to: '2026-11-07T00:00:00Z' })).toEqual({ items: [] })
  })

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
