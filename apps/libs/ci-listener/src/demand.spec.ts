/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDemand, rebuildDemand } from './demand'
import { ListenerInbox, verifyWebhook } from './webhook'
import { ListenerState, ExecutionLease } from './state/store'
import { SqliteStateDatabase } from './state/sqlite'
import { Json, StateConflict, StateCorrupt } from './state/database'
import { WorkflowJob } from './jobs'

describe('CI label demand counters and fallback', () => {
  let directory: string, db: SqliteStateDatabase, state: ListenerState, inbox: ListenerInbox, lease: ExecutionLease
  const secret = Buffer.alloc(32, 1)
  const target = { installationId: 1, accountId: 7, repositoryId: 21 }
  const job = (id = 55, labels = ['boxlite']): WorkflowJob => ({
    repository: 21,
    run: 33,
    job: id,
    status: 'queued',
    runner: null,
    labels,
  })
  const send = (
    status: 'queued' | 'in_progress' | 'completed',
    id = 55,
    labels = ['boxlite'],
    runner: number | null = null,
  ) => {
    const raw = Buffer.from(
      JSON.stringify({
        action: status,
        installation: { id: 1 },
        repository: { id: 21, owner: { id: 7 } },
        workflow_job: { id, run_id: 33, status, labels, runner_id: runner },
      }),
    )
    return inbox.receive(
      verifyWebhook(
        {
          raw,
          delivery: randomUUID(),
          event: 'workflow_job',
          signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
        },
        secret,
      )!,
    )
  }
  const counters = () => state.recover(lease, 1000, ['demand/'])
  const wake = async () => (await state.read(['wake/1/21']))[0]?.version
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-demand-'))
    db = new SqliteStateDatabase(directory)
    state = new ListenerState(db, 'app:' + randomUUID())
    await state.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    inbox = new ListenerInbox(state)
  })
  afterEach(async () => {
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps resource profiles separate and canonicalizes equivalent requested labels', async () => {
    await send('queued', 55, ['LINUX', 'BOXLITE'])
    await send('queued', 56, ['boxlite', 'linux'])
    await send('queued', 57, ['boxlite-4vcpu-8gbmem-20gbdisk'])
    const values = (await counters()).map(decodeDemand)
    expect(values).toHaveLength(2)
    expect(values.find((value) => value.labels.includes('boxlite'))?.queued).toBe(2)
    expect(values.find((value) => value.labels.includes('boxlite-4vcpu-8gbmem-20gbdisk'))?.queued).toBe(1)
  })
  it('removes cancelled demand even when completion has no runner or labels', async () => {
    await send('queued')
    await send('completed', 55, [])
    expect((await counters()).map(decodeDemand)).toEqual([expect.objectContaining({ queued: 0, dirty: false })])
    expect((await state.read(['job-fact/1/55']))[0].payload).toMatchObject({
      status: 'completed',
      runner: null,
      labels: ['boxlite'],
    })
  })
  it('does not resurrect a job whose running notification arrived before queued', async () => {
    await send('in_progress', 55, ['boxlite'], 91)
    await send('queued')
    expect(await counters()).toEqual([])
    expect((await state.read(['job-fact/1/55']))[0].payload).toMatchObject({ status: 'in_progress', runner: 91 })
  })
  it('marks a missing aggregate dirty instead of publishing a negative count', async () => {
    await send('queued')
    const [row] = await counters()
    await state.commit(lease, [{ key: row.key, expected: row.version }])
    await send('in_progress', 55, ['boxlite'], 91)
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: true })
    const previous = await counters()
    await rebuildDemand(state, lease, target, previous, [], await wake())
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
  })
  it('rebuilds from current unassigned jobs and creates missing job facts', async () => {
    await send('queued')
    const previous = await counters()
    await rebuildDemand(
      state,
      lease,
      target,
      previous,
      [job(56), job(57, ['boxlite-2vcpu-4gbmem-10gbdisk'])],
      await wake(),
    )
    const values = (await counters()).map(decodeDemand)
    expect(values.map((value) => value.queued)).toEqual([1, 1])
    expect(await state.read(['job-fact/1/56', 'job-fact/1/57'])).toHaveLength(2)
  })
  it('drops an unusable aggregate after an authoritative empty queue snapshot', async () => {
    await send('queued')
    const [row] = await counters()
    await state.commit(lease, [{ key: row.key, expected: row.version, payload: { broken: true } }])
    const refreshed = await rebuildDemand(state, lease, target, await counters(), [], await wake())
    expect(refreshed).toEqual([])
    expect(await counters()).toEqual([])
    expect(await state.read(['job-fact/1/55'])).toHaveLength(1)
  })
  it('does not count assigned, non-queued or other-repository jobs in a fallback', async () => {
    await send('queued')
    const previous = await counters()
    await rebuildDemand(
      state,
      lease,
      target,
      previous,
      [
        { ...job(56), status: 'in_progress', runner: 91 },
        { ...job(57), runner: 92 },
        { ...job(58), repository: 22 },
      ],
      await wake(),
    )
    expect((await counters()).map(decodeDemand)).toEqual([expect.objectContaining({ queued: 0 })])
  })
  it('preserves a newer webhook instead of overwriting it with an older fallback snapshot', async () => {
    await send('queued')
    const previous = await counters(),
      captured = await wake()
    await send('queued', 56)
    await expect(rebuildDemand(state, lease, target, previous, [job()], captured)).rejects.toBeInstanceOf(StateConflict)
    expect(decodeDemand((await counters())[0]).queued).toBe(2)
  })
  it('rejects a changed counter version even if the wake version stayed the same', async () => {
    await send('queued')
    const previous = await counters(),
      captured = await wake()
    await state.commit(lease, [
      {
        key: previous[0].key,
        expected: previous[0].version,
        payload: { ...(previous[0].payload as object), dirty: true } as Json,
      },
    ])
    await expect(rebuildDemand(state, lease, target, previous, [job()], captured)).rejects.toBeInstanceOf(StateConflict)
    expect(decodeDemand((await counters())[0]).dirty).toBe(true)
  })
  it('does not resurrect a terminal job from a stale GitHub scan', async () => {
    await send('queued')
    await send('completed')
    await rebuildDemand(state, lease, target, await counters(), [job()], await wake())
    expect(decodeDemand((await counters())[0]).queued).toBe(0)
  })
  it('exposes source versions as snapshot fences without persisting them in payload', async () => {
    await send('queued')
    const [row] = await counters(),
      value = decodeDemand(row)
    expect(value).toMatchObject({ key: row.key, version: row.version })
    expect(row.payload).not.toHaveProperty('key')
    expect(row.payload).not.toHaveProperty('version')
  })
  it.each([{ queued: -1 }, { queued: 1.5 }, { labels: [] }, { dirty: 'false' }, { repositoryId: 0 }, { job: null }])(
    'rejects malformed durable counts %j',
    async (change) => {
      await send('queued')
      const [row] = await counters()
      expect(() =>
        decodeDemand({ ...row, payload: { ...(row.payload as object), ...change } as unknown as Json }),
      ).toThrow(StateCorrupt)
    },
  )
})
