/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDemand, JobObservation, observeDemand, rebuildDemand, rebuildQueueSnapshot } from './demand'
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

  it('invalidates an older queue fence when an authoritative scan discovers a new label counter', async () => {
    await send('queued')
    const [original] = await state.read(['queue-revision/1/21'])
    await rebuildDemand(
      state,
      lease,
      target,
      await counters(),
      [job(56, ['boxlite-4vcpu-8gbmem-20gbdisk'])],
      await wake(),
    )
    const [updated] = await state.read([original.key])
    expect(updated.version).not.toBe(original.version)
    await expect(
      state.commit(
        lease,
        [{ key: 'retirement-test', expected: null, payload: true }],
        [{ key: original.key, version: original.version }],
      ),
    ).rejects.toBeInstanceOf(StateConflict)
    expect(await state.read(['retirement-test'])).toHaveLength(0)
    expect(
      (await counters()).map(decodeDemand).find((row) => row.labels[0] === 'boxlite-4vcpu-8gbmem-20gbdisk')?.queued,
    ).toBe(1)
  })
  it('rolls back a scan invalidated after staging the repository revision', async () => {
    const scan = new AbortController()
    const ingress = state.ingress.bind(state)
    jest.spyOn(state, 'ingress').mockImplementationOnce((target, work, lease, signal) =>
      ingress(
        target,
        (tx) =>
          work({
            ...tx,
            write: async (changes) => {
              const result = await tx.write(changes)
              if (changes.some((change) => change.key.startsWith('queue-revision/'))) scan.abort(new StateConflict())
              return result
            },
          }),
        lease,
        signal,
      ),
    )
    const snapshot = rebuildQueueSnapshot(state, lease, target, [], [job()], undefined, undefined, scan.signal)
    await expect(snapshot).rejects.toBeInstanceOf(StateConflict)
    expect(scan.signal.aborted).toBe(true)
    expect(await counters()).toHaveLength(0)
    expect(await state.read(['job-fact/1/55', 'queue-revision/1/21'])).toEqual([])
  })
  it('keeps unchanged authoritative snapshots stable so pending consumers are not invalidated by polling', async () => {
    await send('queued')
    const prior = await counters(),
      [revision] = await state.read(['queue-revision/1/21'])
    await rebuildDemand(state, lease, target, prior, [job()], await wake())
    await rebuildDemand(state, lease, target, await counters(), [job()], await wake())
    expect((await counters())[0].version).toBe(prior[0].version)
    expect((await state.read([revision.key]))[0].version).toBe(revision.version)
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
  it.each(['scan', 'events'])('counts two queued jobs from the pinned PAT repository through %s', async (source) => {
    const pat = { ...target, installationId: 0 }
    if (source === 'scan') await rebuildDemand(state, lease, pat, [], [job(55), job(56)])
    else {
      for (const id of [55, 56]) {
        await state.ingress('0/21', async (tx) => {
          const changes = await observeDemand(
            tx,
            { ...pat, job: { id, runId: 33 } },
            {
              status: 'queued',
              labels: ['boxlite'],
              runner: null,
            },
          )
          await tx.write(changes)
        })
      }
    }
    const rows = await counters()
    expect(rows.map(decodeDemand)).toEqual([expect.objectContaining({ installationId: 0, queued: 2, dirty: false })])
    for (const invalid of [-1, 0.5, '0']) {
      expect(() =>
        decodeDemand({
          ...rows[0],
          payload: { ...(rows[0].payload as Record<string, Json>), installationId: invalid },
        }),
      ).toThrow(StateCorrupt)
    }
  })
  it('retains the other queued job after replacement and a late completion', async () => {
    await send('queued', 55)
    await rebuildDemand(state, lease, target, await counters(), [job(56)], await wake())
    await send('completed', 55)
    await send('completed', 55)
    expect((await state.read(['job-fact/1/56']))[0].payload).toMatchObject({ status: 'queued' })
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 1, dirty: false })
    await send('completed', 56)
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
  })
  it('keeps the scanned job after a later scan excludes an incremental arrival', async () => {
    await rebuildDemand(state, lease, target, [], [job(56)])
    await send('queued', 57)
    await rebuildDemand(state, lease, target, await counters(), [job(56)], await wake())
    await send('completed', 57)
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 1, dirty: false })
    await send('completed', 56)
    expect(decodeDemand((await counters())[0]).queued).toBe(0)
  })
  it('rebuilds a historical counter when a completion has no membership evidence', async () => {
    await send('queued', 55)
    const [count] = await counters()
    const [fact] = await state.read(['job-fact/1/55'])
    const counterPayload = { ...(count.payload as Record<string, Json>) }
    const factPayload = { ...(fact.payload as Record<string, Json>) }
    delete counterPayload.membership
    delete factPayload.countedFor
    await state.commit(lease, [
      { key: count.key, expected: count.version, payload: counterPayload },
      { key: fact.key, expected: fact.version, payload: factPayload },
    ])
    await send('completed', 55)
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 1, dirty: true })
    await rebuildDemand(state, lease, target, await counters(), [job(56)], await wake())
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 1, dirty: false })
  })
  it('replaces contributors when a repeated job preserves the total count', async () => {
    await rebuildDemand(state, lease, target, [], [job(55), job(56)])
    await rebuildDemand(state, lease, target, await counters(), [job(56), job(56)])
    await send('completed', 55)
    expect(decodeDemand((await counters())[0]).queued).toBe(2)
    await send('completed', 56)
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
  })
  it('does not resurrect a job whose running notification arrived before queued', async () => {
    await send('in_progress', 55, ['boxlite'], 91)
    await send('queued')
    expect(await counters()).toEqual([])
    expect((await state.read(['job-fact/1/55']))[0].payload).toMatchObject({ status: 'in_progress', runner: 91 })
  })
  it.each([
    { status: 'unknown' },
    { labels: null },
    { labels: [''] },
    { labels: [1] },
    { labels: ['x'.repeat(129)] },
    { labels: Array(101).fill('boxlite') },
    { labels: [] },
    { runner: 0 },
  ])('rejects invalid internal observations without changing durable facts %j', async (change) => {
    await expect(
      state.ingress('1/21', async (tx) => {
        const changes = await observeDemand(tx, { ...target, job: { id: 55, runId: 33 } }, {
          status: 'queued',
          labels: ['boxlite'],
          runner: null,
          ...change,
        } as JobObservation)
        await tx.write(changes)
      }),
    ).rejects.toBeInstanceOf(StateCorrupt)
    expect(await state.recover(lease)).toEqual([])
  })
  it('requires a job identity for an internal observation', async () => {
    await expect(
      state.ingress('1/21', (tx) =>
        observeDemand(
          tx,
          { ...target, job: null },
          {
            status: 'queued',
            labels: ['boxlite'],
            runner: null,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(StateCorrupt)
    expect(await state.recover(lease)).toEqual([])
  })
  it.each([
    null,
    {},
    { hint: {} },
    { hint: { job: {} }, status: 'invalid', labels: [] },
    { hint: { job: {} }, status: 'queued', labels: null },
    { hint: { job: {} }, status: 'queued', labels: [1] },
  ])('rejects malformed persisted observations before applying a transition %j', async (payload) => {
    await send('queued')
    const [fact] = await state.read(['job-fact/1/55'])
    await state.commit(lease, [{ key: fact.key, expected: fact.version, payload: payload as Json }])
    const before = await state.recover(lease)
    await expect(send('completed')).rejects.toBeInstanceOf(StateCorrupt)
    expect(await state.recover(lease)).toEqual(before)
  })
  it.each([
    null,
    {},
    { repository: 0, run: 33, job: 55, status: 'completed' },
    { repository: 21, run: null, job: 55, status: 'in_progress' },
    { repository: 21, run: 33, job: '55', status: 'in_progress' },
    { repository: 21, run: 33, job: 55, status: 'queued' },
    { repository: 21, run: 33, job: 55, status: 'in_progress', ambiguous: 'true' },
  ])('rejects a malformed runner claim without consuming queued demand %j', async (payload) => {
    await send('queued')
    await state.commit(lease, [{ key: 'runner-claim/1/91', expected: null, payload: payload as Json }])
    const before = await state.recover(lease)
    await expect(send('in_progress', 55, ['boxlite'], 91)).rejects.toBeInstanceOf(StateCorrupt)
    expect(await state.recover(lease)).toEqual(before)
  })
  it('accepts sequential runner reuse without losing job facts or queued counts', async () => {
    await send('queued', 55)
    await send('in_progress', 55, ['boxlite'], 91)
    await send('completed', 55, [], 91)
    await send('queued', 56)
    await send('in_progress', 56, ['boxlite'], 91)
    const [current] = await state.read(['runner-claim/1/91'])
    expect(current.payload).toEqual({ repository: 21, run: 33, job: 56, status: 'in_progress', ambiguous: true })
    await send('completed', 55, [], 91)
    expect((await state.read(['runner-claim/1/91']))[0]).toEqual(current)
    expect((await state.read(['job-fact/1/55', 'job-fact/1/56'])).map((row) => row.payload)).toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'in_progress' }),
    ])
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
  })
  it('accepts overlapping runner observations conservatively and ignores an older completion claim', async () => {
    await send('queued', 55)
    await send('queued', 56)
    await send('in_progress', 55, ['boxlite'], 91)
    await send('in_progress', 56, ['boxlite'], 91)
    const [current] = await state.read(['runner-claim/1/91'])
    expect(current.payload).toEqual({ repository: 21, run: 33, job: 56, status: 'in_progress', ambiguous: true })
    await send('completed', 55, [], 91)
    expect((await state.read(['runner-claim/1/91']))[0]).toEqual(current)
    expect((await state.read(['job-fact/1/55']))[0].payload).toMatchObject({ status: 'completed' })
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
  })
  it('advances an existing runner claim from running to completed for the same job', async () => {
    await send('queued')
    await send('in_progress', 55, ['boxlite'], 91)
    const [running] = await state.read(['runner-claim/1/91'])
    await send('completed', 55, [], 91)
    const [completed] = await state.read(['runner-claim/1/91'])
    expect(completed.version).not.toBe(running.version)
    expect(completed.payload).toEqual({ repository: 21, run: 33, job: 55, status: 'completed' })
    expect(decodeDemand((await counters())[0])).toMatchObject({ queued: 0, dirty: false })
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
  it('rolls back missing fact batches when a counter snapshot has changed', async () => {
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
    await expect(
      rebuildDemand(
        state,
        lease,
        target,
        previous,
        Array.from({ length: 101 }, (_, index) => job(index + 100)),
        captured,
      ),
    ).rejects.toBeInstanceOf(StateConflict)
    expect(await state.recover(lease, 1000, ['job-fact/'])).toEqual([expect.objectContaining({ key: 'job-fact/1/55' })])
    expect(decodeDemand((await counters())[0]).dirty).toBe(true)
  })
  it.each([0, 100])('preserves duplicate job counting across %s other facts', async (others) => {
    await rebuildDemand(
      state,
      lease,
      target,
      [],
      [job(), ...Array.from({ length: others }, (_, index) => job(index + 100)), job()],
    )
    expect((await counters()).map(decodeDemand)).toEqual([expect.objectContaining({ queued: others + 2 })])
    expect(await state.recover(lease, 1000, ['job-fact/'])).toHaveLength(others + 1)
  })
  it('migrates inline snapshot membership and preserves duplicate contributions', async () => {
    const scanned = [job(55), job(55), job(56)]
    const { demands } = await rebuildQueueSnapshot(state, lease, target, [], scanned)
    const [counter] = demands
    const legacy = decodeDemand(counter)
    const facts = await state.read(['job-fact/1/55', 'job-fact/1/56'])
    await state.commit(lease, [
      {
        key: counter.key,
        expected: counter.version,
        payload: {
          ...(counter.payload as Record<string, Json>),
          membership: { generation: legacy.membership!.generation, jobs: scanned.map((item) => item.job) },
        },
      },
      ...facts.map((fact) => {
        const payload = { ...(fact.payload as Record<string, Json>) }
        delete payload.countedFor
        delete payload.countedWeight
        return { key: fact.key, expected: fact.version, payload }
      }),
    ])
    const rebuilt = await rebuildQueueSnapshot(state, lease, target, await counters(), scanned)
    expect(decodeDemand(rebuilt.demands[0]).membership?.jobs).toHaveLength(0)
    await send('completed', 55)
    expect(decodeDemand((await counters())[0]).queued).toBe(1)
  })
  it('publishes an oversized label group and debits its last job on completion', async () => {
    const jobs = Array.from({ length: 90000 }, (_, index) => job(10000000000 + index))
    const { demands, revision } = await rebuildQueueSnapshot(state, lease, target, [], jobs)
    expect(decodeDemand(demands[0]).queued).toBe(jobs.length)
    expect((await state.read(['queue-revision/1/21']))[0].version).toBe(revision.version)
    await send('completed', jobs[jobs.length - 1].job)
    expect(decodeDemand((await counters())[0]).queued).toBe(jobs.length - 1)
  }, 90000)
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
