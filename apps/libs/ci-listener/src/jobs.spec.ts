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
      if (++started === 5) release()
      if (url.searchParams.get('status') === 'queued') {
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
    expect(settledAtClose).toBe(4)
  })
  it('overlaps all five active-status reads before awaiting their responses', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    global.fetch = jest.fn(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/repositories/21') return new Response(JSON.stringify(repository))
      started.push(url.searchParams.get('status')!)
      await held
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }))
    }) as typeof fetch
    const reading = reader.queued()
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(started.sort()).toEqual(['in_progress', 'pending', 'queued', 'requested', 'waiting'])
    } finally {
      release()
      await reading
    }
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
