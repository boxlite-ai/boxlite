import { randomUUID } from 'crypto'
import { DataSource } from 'typeorm'
import { AddRunnerCpuIncidents1793232000000 } from '../../migrations/pre-deploy/1793232000000-add-runner-cpu-incidents-migration'
import { RunnerCpuIncidentDto } from './cpu-incident.dto'
import { RunnerCpuIncident } from './cpu-incident.entity'
import { CpuIncidentService } from './cpu-incident.service'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `cpu_incident_${process.pid}_${randomUUID().replaceAll('-', '')}`
const runnerId = '11111111-1111-4111-8111-111111111111'
const otherRunner = '22222222-2222-4222-8222-222222222222'
const range = { from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' }
const report = (): RunnerCpuIncidentDto => ({
  eventId: randomUUID(),
  highCpuSince: '2026-10-29T00:00:00Z',
  windowStartedAt: '2026-10-29T00:05:00Z',
  windowEndedAt: '2026-10-29T00:07:00Z',
  runnerCpuPercent: 80.1,
  boxId: 'business-box',
  cpuSeconds: 240,
  samplingComplete: true,
})

describeWithDatabase('CPU incident PostgreSQL persistence', () => {
  let db: DataSource
  let service: CpuIncidentService
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
      entities: [RunnerCpuIncident],
      migrations: [AddRunnerCpuIncidents1793232000000],
      migrationsTransactionMode: 'each',
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.runMigrations()
    service = new CpuIncidentService(db)
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.undoLastMigration()
      expect(await db.query(`SELECT to_regclass('${schema}.runner_cpu_incident') AS name`)).toEqual([{ name: null }])
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE runner_cpu_incident RESTART IDENTITY')
  })

  it('persists the exact winning image and keeps it immutable on retry', async () => {
    const first = { ...report(), image: 'registry.example/team/image:tag@sha256:abc' }
    await service.record(runnerId, first)
    const retry = { ...first, image: 'changed:latest' }
    await service.record(runnerId, retry)
    const empty = { ...report(), image: '' }
    await service.record(runnerId, empty)
    await service.record(runnerId, report())
    const missing = { ...report(), boxId: null, image: null, cpuSeconds: 0 }
    await service.record(runnerId, missing)
    const { items } = await service.list({ ...range, limit: 50 })
    expect(items).toMatchObject([
      { boxId: first.boxId, image: first.image },
      { image: '' },
      { image: null },
      { boxId: null, image: null },
    ])
  })

  it('stores immutable deduplicated reports and limits results using business box ID', async () => {
    const first = report()
    await service.record(runnerId, first)
    await service.record(runnerId, { ...first, boxId: 'changed', cpuSeconds: 999 })
    await service.record(otherRunner, first)
    await service.record(runnerId, { ...report(), boxId: null, cpuSeconds: 0, samplingComplete: false })
    const result = await service.list({ ...range, limit: 1 })
    expect(Object.keys(result)).toEqual(['items'])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ runnerId, eventId: first.eventId, boxId: 'business-box', cpuSeconds: 240 })
    const all = await service.list({ ...range, limit: 50 })
    expect(all.items).toHaveLength(3)
    expect(all.items[2].boxId).toBeNull()
    expect((await service.list({ ...range, limit: 50, runnerId })).items).toHaveLength(2)
    expect(await service.list({ from: range.to, to: '2026-10-31T00:00:00Z', limit: 50 })).toEqual({ items: [] })
  })

  it('filters capture completion in [from,to) and returns the first N rows by ID', async () => {
    const completed = ['2026-10-29T00:07:00Z', '2026-10-29T00:07:01Z', '2026-10-29T00:07:02Z']
    for (const windowEndedAt of completed) await service.record(runnerId, { ...report(), windowEndedAt })
    await service.record(otherRunner, { ...report(), windowEndedAt: completed[1] })
    const query = { from: completed[0], to: completed[2], limit: 1, runnerId }
    const first = await service.list(query)
    expect(first.items.map((item) => item.windowEndedAt.toISOString())).toEqual(['2026-10-29T00:07:00.000Z'])
    const two = await service.list({ ...query, limit: 2 })
    expect(two.items.map((item) => item.windowEndedAt.toISOString())).toEqual([
      '2026-10-29T00:07:00.000Z',
      '2026-10-29T00:07:01.000Z',
    ])
    expect(await service.list(query)).toEqual(first)
    expect((await service.list({ ...query, from: completed[1], limit: 50 })).items).toHaveLength(1)
    const withOffset = await service.list({ ...query, from: '2026-10-29T08:07:00+08:00', limit: 50 })
    expect(withOffset.items).toHaveLength(2)
    expect((await service.list({ ...query, runnerId: undefined, limit: 50 })).items).toHaveLength(3)
    expect((await service.list({ ...query, from: completed[2], to: '2026-10-29T00:08:00Z' })).items).toHaveLength(1)
  })

  it.each([range.from, '2026-10-28T00:00:00Z', 'invalid'])('rejects invalid range ending %s', async (to) => {
    await expect(service.list({ ...range, to, limit: 50 })).rejects.toThrow('Invalid CPU incident time range')
  })

  it.each([
    { windowStartedAt: '2026-10-29T00:04:59Z' },
    { windowEndedAt: '2026-10-29T00:06:59Z' },
    { runnerCpuPercent: 80 },
    { boxId: null, cpuSeconds: 2 },
    { boxId: null, cpuSeconds: 0, image: 'unattributed:latest' },
    { cpuSeconds: 0 },
    { windowEndedAt: 'bad' },
  ])('rejects incoherent report %j', async (extra) => {
    await expect(service.record(runnerId, { ...report(), ...extra })).rejects.toThrow('Invalid CPU incident')
    expect((await service.list({ ...range, limit: 50 })).items).toHaveLength(0)
  })

  it('enforces the five-minute and strict 80 percent boundaries in PostgreSQL', async () => {
    const insert = (extra: Partial<RunnerCpuIncidentDto>) => {
      const incident = { ...report(), ...extra }
      return db.getRepository(RunnerCpuIncident).insert({
        ...incident,
        runnerId,
        highCpuSince: new Date(incident.highCpuSince),
        windowStartedAt: new Date(incident.windowStartedAt),
        windowEndedAt: new Date(incident.windowEndedAt),
      })
    }
    await expect(insert({ runnerCpuPercent: 80 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ windowStartedAt: '2026-10-29T00:04:59Z' })).rejects.toMatchObject({ code: '23514' })
    await insert({})
    expect(await db.getRepository(RunnerCpuIncident).count()).toBe(1)
  })

  it('preserves row ID precision beyond JavaScript safe integers', async () => {
    await db.query('ALTER TABLE runner_cpu_incident ALTER COLUMN id RESTART WITH 9007199254740993')
    await service.record(runnerId, report())
    const result = await service.list({ ...range, limit: 50 })
    expect(result.items[0].id).toBe('9007199254740993')
  })

  it('deduplicates concurrent uploads of the same event', async () => {
    const incident = report()
    await Promise.all(Array.from({ length: 8 }, () => service.record(runnerId, incident)))
    const result = await service.list({ ...range, limit: 50 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ runnerId, eventId: incident.eventId, boxId: incident.boxId })
  })
})
