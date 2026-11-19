/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubCredential } from './github-app'
import { GitHubJobs, jobMatches } from './jobs'
import type { JobNotice, WorkflowJob } from './jobs'
import { GitHubRequestError } from './github'

describe('CI shared GitHub jobs', () => {
  const original = global.fetch,
    repository = { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true }
  const queued = (extra: Record<string, unknown> = {}) => ({
    id: 55,
    run_id: 33,
    status: 'queued',
    conclusion: null,
    completed_at: null,
    labels: ['boxlite'],
    runner_id: null,
    ...extra,
  })
  let calls: string[], reader: GitHubJobs, reply: (url: URL) => unknown
  beforeEach(() => {
    calls = []
    reader = new GitHubJobs(GitHubCredential.personal('test-only-token'), repository)
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued())
    global.fetch = jest.fn(async (input) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      const response = reply(url)
      return response instanceof Response ? response : new Response(JSON.stringify(response))
    }) as typeof fetch
  })
  afterEach(() => {
    global.fetch = original
  })
  const notice = { repository: 21, run: 33, job: 55 }
  const pending = (notices: readonly JobNotice[]) =>
    (reader as unknown as { pending(notices: readonly JobNotice[]): Promise<WorkflowJob[]> }).pending(notices)
  it('reads notified run jobs once and fetches a missing first-page job directly', async () => {
    reply = (url) => {
      if (url.pathname === '/repositories/21') return repository
      if (url.pathname.endsWith('/runs/33/jobs')) return { total_count: 101, jobs: [queued()] }
      if (url.pathname.endsWith('/jobs/56')) return queued({ id: 56 })
      throw new Error('Unexpected enumeration: ' + url.pathname)
    }
    expect(await pending([notice, { ...notice, job: 56 }])).toEqual([
      expect.objectContaining({ job: 55 }),
      expect.objectContaining({ job: 56 }),
    ])
    expect(calls).toEqual([
      '/repositories/21',
      '/repos/owner/repo/actions/runs/33/jobs?filter=latest&per_page=100&page=1',
      '/repos/owner/repo/actions/jobs/56',
      '/repositories/21',
    ])
  })
  it.each([{ repository: 22 }, { run: 0 }, { job: 0 }])(
    'rejects an out-of-scope notified batch %j before HTTP',
    async (change) => {
      await expect(pending([{ ...notice, ...change }])).rejects.toThrow('original repository')
      expect(calls).toEqual([])
    },
  )
  it('rejects a notified job whose returned run identity changed', async () => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued({ run_id: 34 }))
    await expect(pending([notice])).rejects.toThrow('workflow job')
  })
  it.each([
    { total_count: 1, jobs: [queued(), queued({ id: 56 })] },
    { total_count: 2, jobs: [queued(), queued()] },
  ])('rejects a malformed or duplicate notified-run inventory: %j', async (inventory) => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : inventory)
    await expect(pending([notice, { ...notice, job: 56 }])).rejects.toThrow(/inventory|Duplicate/)
    expect(calls.filter((path) => path === '/repositories/21')).toHaveLength(1)
  })
  it('rejects a point lookup returning another job from the same run', async () => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued({ id: 56 }))
    await expect(pending([notice])).rejects.toThrow('identity changed')
  })
  it('cancels notified-job reads through the caller signal before returning evidence', async () => {
    const controller = new AbortController()
    let started!: () => void
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    global.fetch = jest.fn(async (input, options) => {
      if (new URL(String(input)).pathname === '/repositories/21') return new Response(JSON.stringify(repository))
      started()
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
      })
    }) as typeof fetch
    const result = reader.pending([notice], controller.signal)
    const rejected = expect(result).rejects.toBeInstanceOf(GitHubRequestError)
    await reading
    controller.abort(new Error('caller stopped'))
    await rejected
  })
  it('drains aborted sibling requests before credential close and preserves the initiating 429', async () => {
    let started = 0,
      settled = 0,
      release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const owned = GitHubCredential.installation(
      {
        token: 'test-only-token',
        permissions: { actions: 'read' },
        repositories: [{ id: 21 }],
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      { actions: 'read' },
      21,
      Date.now,
    )
    reader = new GitHubJobs(owned, repository)
    let settledAtClose = -1
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input))
      if (url.pathname === '/installation/token') {
        settledAtClose = settled
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/repositories/21') return new Response(JSON.stringify(repository))
      if (url.searchParams.get('status') === 'queued')
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }))
      if (++started === 4) release()
      if (url.searchParams.get('status') === 'in_progress') {
        await ready
        return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
      }
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () =>
            setImmediate(() => {
              settled++
              reject(new Error('aborted sibling'))
            }),
          { once: true },
        )
      })
    }) as typeof fetch
    const before = Date.now()
    const error = await reader
      .queued()
      .finally(() => owned.close())
      .catch((error) => error)
    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.status).toBe(429)
    expect(error.retryAt).toBeGreaterThanOrEqual(before + 60000)
    expect(settledAtClose).toBe(3)
  })
  it('finishes queued sampling before overlapping the four remaining active-status reads', async () => {
    let releaseQueued!: () => void, releaseOthers!: () => void, entered!: () => void, allStarted!: () => void
    const queuedHeld = new Promise<void>((resolve) => {
      releaseQueued = resolve
    })
    const othersHeld = new Promise<void>((resolve) => {
      releaseOthers = resolve
    })
    const queuedStarted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const othersStarted = new Promise<void>((resolve) => {
      allStarted = resolve
    })
    const started: string[] = []
    global.fetch = jest.fn(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/repositories/21') return new Response(JSON.stringify(repository))
      const status = url.searchParams.get('status')!
      started.push(status)
      if (status === 'queued') {
        entered()
        await queuedHeld
      } else {
        if (started.length === 5) allStarted()
        await othersHeld
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }))
    }) as typeof fetch
    const reading = reader.queued()
    try {
      await queuedStarted
      expect(started).toEqual(['queued'])
      releaseQueued()
      await othersStarted
      expect(started.slice(1).sort()).toEqual(['in_progress', 'pending', 'requested', 'waiting'])
    } finally {
      releaseQueued()
      releaseOthers()
      await reading
    }
  })
  it('retains a queued job while its run moves from queued to in_progress between status responses', async () => {
    let transitioned = false
    global.fetch = jest.fn(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/repositories/21') return new Response(JSON.stringify(repository))
      if (url.pathname.endsWith('/runs/33/jobs'))
        return new Response(JSON.stringify({ total_count: 1, jobs: [queued()] }))
      const status = url.searchParams.get('status')
      if (status === 'queued') {
        await new Promise<void>((resolve) => setImmediate(resolve))
        const runs = transitioned ? [] : [{ id: 33, repository: { id: 21 } }]
        return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }))
      }
      if (status === 'in_progress') transitioned = true
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }))
    }) as typeof fetch
    expect(await reader.queued()).toEqual([expect.objectContaining({ job: 55, status: 'queued' })])
  })
  it('reads the original job between repository identity checks', async () => {
    expect(await reader.job(notice)).toMatchObject({ ...notice, status: 'queued', runner: null })
    expect(calls).toEqual(['/repositories/21', '/repos/owner/repo/actions/jobs/55', '/repositories/21'])
  })
  it('captures original notice identity before asynchronous repository checks', async () => {
    const mutable = { ...notice }
    reply = (url) => {
      if (url.pathname === '/repositories/21') {
        mutable.run = 34
        mutable.job = 56
        return repository
      }
      return url.pathname.endsWith('/55') ? queued() : queued({ id: 56, run_id: 34 })
    }
    expect(await reader.job(mutable)).toMatchObject(notice)
    expect(calls).toContain('/repos/owner/repo/actions/jobs/55')
    expect(calls).not.toContain('/repos/owner/repo/actions/jobs/56')
  })
  it.each([0, null])('accepts an unassigned GitHub runner_id of %s', async (runner_id) => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued({ runner_id }))
    const job = await reader.job(notice)
    expect(jobMatches(job, ['self-hosted', 'linux', 'x64', 'boxlite'])).toBe(true)
    expect(job.runner).toBeNull()
  })
  it('rejects a notice from another repository before sending HTTP', async () => {
    await expect(reader.job({ ...notice, repository: 22 })).rejects.toThrow('original repository')
    expect(calls).toEqual([])
  })
  it.each(['waiting', 'requested', 'pending'])('preserves the non-runnable active status %s', async (status) => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued({ status }))
    const job = await reader.job(notice)
    expect(job.status).toBe(status)
    expect(jobMatches(job, ['boxlite'])).toBe(false)
  })
  it.each([{ id: 56 }, { run_id: 34 }, { labels: null }, { runner_id: -1 }, { status: 'unknown' }])(
    'rejects changed or malformed job identity %j',
    async (change) => {
      reply = (url) => (url.pathname === '/repositories/21' ? repository : queued(change))
      await expect(reader.job(notice)).rejects.toThrow()
    },
  )
  it('rejects repository transfer and privacy changes observed after the job read', async () => {
    let checks = 0
    reply = (url) =>
      url.pathname === '/repositories/21'
        ? ++checks === 1
          ? repository
          : { ...repository, owner: { id: 8, login: 'other' } }
        : queued()
    await expect(reader.job(notice)).rejects.toThrow('authority changed')
  })
  it.each([
    { status: 'queued', conclusion: 'success' },
    { status: 'completed', conclusion: null },
    { status: 'completed', conclusion: 'success', completed_at: 'invalid' },
  ])('rejects inconsistent completion metadata %j', async (change) => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : queued(change))
    await expect(reader.job(notice)).rejects.toThrow('workflow job')
  })
  it('admits only a queued, unassigned job whose complete label set is supported', async () => {
    const job = await reader.job(notice)
    expect(
      jobMatches({ ...job, labels: ['self-hosted', 'Linux', 'boxlite'] }, ['self-hosted', 'linux', 'boxlite']),
    ).toBe(true)
    for (const changed of [
      { ...job, labels: ['self-hosted'] },
      { ...job, labels: ['boxlite', 'macOS'] },
      { ...job, runner: 42 },
      { ...job, status: 'in_progress' as const },
    ])
      expect(jobMatches(changed, ['self-hosted', 'linux', 'boxlite'])).toBe(false)
  })
  it('scans all active run states once and reads queued jobs in a running workflow', async () => {
    reply = (url) => {
      if (url.pathname === '/repositories/21') return repository
      if (url.pathname.endsWith('/actions/runs'))
        return { total_count: 1, workflow_runs: [{ id: 33, repository: { id: 21 } }] }
      return { total_count: 2, jobs: [queued(), queued({ id: 56, status: 'in_progress', runner_id: 4 })] }
    }
    expect(await reader.queued()).toEqual([expect.objectContaining(notice)])
    expect(calls.filter((path) => path.includes('/runs?status='))).toHaveLength(5)
    expect(calls.filter((path) => path.includes('/runs/33/jobs?'))).toHaveLength(1)
  })
  it.each([
    { total_count: 1001, workflow_runs: [] },
    { total_count: 1000, workflow_runs: [] },
    { total_count: 2, workflow_runs: [{ id: 33, repository: { id: 21 } }] },
    {
      total_count: 2,
      workflow_runs: [
        { id: 33, repository: { id: 21 } },
        { id: 33, repository: { id: 21 } },
      ],
    },
    { total_count: 1, workflow_runs: [{ id: 33, repository: { id: 22 } }] },
  ])('rejects incomplete, capped or unauthorized run inventories %j', async (inventory) => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : inventory)
    await expect(reader.queued()).rejects.toThrow()
  })
  it('propagates 403 without interpreting it as an empty queue', async () => {
    reply = (url) => (url.pathname === '/repositories/21' ? repository : new Response('', { status: 403 }))
    await expect(reader.queued()).rejects.toMatchObject({ status: 403, uncertain: false })
  })
})
