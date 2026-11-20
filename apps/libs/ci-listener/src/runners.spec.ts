/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubCredential } from './github-app'
import { GitHubRunners, JitRegistration, RunnerScope } from './runners'
import { WorkerExecutor } from './worker'

describe('CI shared GitHub JIT runners', () => {
  const original = global.fetch,
    name = 'ci-jit-' + 'a'.repeat(32),
    other = 'ci-jit-' + 'b'.repeat(32)
  const repository = { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true }
  const repoScope: RunnerScope = { kind: 'repository', repository, allowPrivate: true, allowPublic: false }
  const orgScope: RunnerScope = {
    kind: 'organization',
    account: { id: 7, login: 'owner' },
    group: 4,
    repositories: [21],
    allowPrivate: true,
    allowPublic: false,
  }
  const group = {
    id: 4,
    visibility: 'selected',
    inherited: false,
    restricted_to_workflows: false,
    allows_public_repositories: false,
  }
  let calls: { route: string; method: string; json: unknown }[],
    journal: jest.Mock,
    reply: (url: URL, method: string) => unknown,
    exists: boolean
  beforeEach(() => {
    calls = []
    journal = jest.fn(async () => {})
    exists = true
    reply = (url, method) => {
      if (url.pathname === '/repositories/21') return repository
      if (url.pathname === '/orgs/owner') return { id: 7, login: 'owner' }
      if (url.pathname.endsWith('/runner-groups/4')) return group
      if (url.pathname.endsWith('/runner-groups/4/repositories')) return { total_count: 1, repositories: [repository] }
      if (url.pathname.endsWith('/generate-jitconfig'))
        return { runner: { id: 91, name }, encoded_jit_config: 'c2VjcmV0' }
      if (method === 'DELETE') {
        exists = false
        return new Response(null, { status: 204 })
      }
      return { total_count: exists ? 1 : 0, runners: exists ? [{ id: 91, name }] : [] }
    }
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input)),
        method = options?.method ?? 'GET'
      calls.push({ route: url.pathname, method, json: options?.body ? JSON.parse(String(options.body)) : undefined })
      if (method !== 'GET') expect(journal).toHaveBeenCalled()
      const value = reply(url, method)
      return value instanceof Response ? value : new Response(JSON.stringify(value))
    }) as typeof fetch
  })
  afterEach(() => {
    global.fetch = original
  })
  const registry = (scope: RunnerScope = repoScope) =>
    new GitHubRunners(
      GitHubCredential.personal('test-only-token'),
      scope,
      ['self-hosted', 'linux', 'x64', 'boxlite'],
      journal,
    )
  const remaining = async () => (exists ? { id: 91, name } : null)
  const onlineIdle = () => {
    const previous = reply
    reply = (url, method) =>
      /\/actions\/runners\/91$/.test(url.pathname) && method === 'GET'
        ? exists
          ? { id: 91, name, status: 'online', busy: false }
          : new Response(null, { status: 404 })
        : previous(url, method)
  }
  it.each([repoScope, orgScope])(
    'retires an original idle runner only after exact 204 and complete absence: %j',
    async (scope) => {
      onlineIdle()
      expect(await registry(scope).retireKnownIdle({ id: 91, name }, remaining)).toBe(true)
      expect(journal).toHaveBeenCalledWith({ kind: 'remove', id: 91, name })
      const route = scope.kind === 'repository' ? '/repos/owner/repo' : '/orgs/owner'
      expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { route: `${route}/actions/runners/91`, method: 'DELETE', json: undefined },
      ])
      expect(await remaining()).toBeNull()
    },
  )
  it.each([
    [404, false],
    [500, 'http'],
    [{ id: 92, name }, 'identity'],
    [{ id: 91, name: other }, 'identity'],
    [{ id: 91, name, status: 'offline', busy: false }, false],
    [{ id: 91, name, status: 'online', busy: true }, false],
  ] as const)('checks the exact runner before retirement when GitHub replies %j', async (response, expected) => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/actions/runners/91') && method === 'GET'
        ? typeof response === 'number'
          ? new Response(null, { status: response })
          : response
        : previous(url, method)
    const retirement = registry().retireKnownIdle({ id: 91, name }, remaining)
    if (expected === 'http') await expect(retirement).rejects.toMatchObject({ status: 500 })
    else if (expected === 'identity') await expect(retirement).rejects.toThrow('Original scale set runner changed')
    else await expect(retirement).resolves.toBe(false)
    expect(journal).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })
  it.each([
    { id: 0, name },
    { id: 91, name: 'unrelated' },
  ])('rejects malformed retirement identity %j before HTTP', async (identity) => {
    await expect(registry().retireKnownIdle(identity, remaining)).rejects.toThrow('Known original runner required')
    expect(calls).toHaveLength(0)
  })
  it('retains ownership after a 204 while the same runner is still in the scale set', async () => {
    onlineIdle()
    const member = jest.fn(async () => ({ id: 91, name }))
    await expect(registry().retireKnownIdle({ id: 91, name }, member)).rejects.toThrow(
      'retirement is not yet confirmed',
    )
    expect(member).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })
  it.each([
    [0, [repository]],
    [2, [repository]],
  ])('rejects an inconsistent repository inventory of %i', async (total, repositories) => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4/repositories')
        ? { total_count: total, repositories }
        : previous(url, method)
    await expect(registry(orgScope).authority(true)).rejects.toThrow('Incomplete GitHub runner authorization inventory')
  })
  it.each([200, 201, 202, 404, 403, 500])('rejects HTTP %i as idle retirement acknowledgement', async (status) => {
    onlineIdle()
    const previous = reply
    reply = (url, method) => (method === 'DELETE' ? new Response(null, { status }) : previous(url, method))
    await expect(registry().retireKnownIdle({ id: 91, name }, remaining)).rejects.toMatchObject({ status })
    expect(journal).toHaveBeenCalledTimes(1)
  })
  it('keeps the runner when a retirement is withdrawn during the mutation check', async () => {
    onlineIdle()
    let wanted = true
    journal.mockImplementationOnce(async () => {
      wanted = false
    })
    const beforeDelete = () => {
      if (!wanted) throw new Error('retirement withdrawn')
    }
    await expect(registry().retireKnownIdle({ id: 91, name }, remaining, undefined, beforeDelete)).rejects.toThrow(
      'retirement withdrawn',
    )
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(exists).toBe(true)
  })
  it('keeps the Box decision pending when a busy assignment races the idle read', async () => {
    onlineIdle()
    const previous = reply
    reply = (url, method) => (method === 'DELETE' ? new Response(null, { status: 422 }) : previous(url, method))
    expect(await registry().retireKnownIdle({ id: 91, name }, remaining)).toBe(false)
    expect(journal).toHaveBeenCalledTimes(1)
  })
  it('does not treat a lost unregister response as safe idle retirement', async () => {
    onlineIdle()
    const previous = reply
    reply = (url, method) => {
      if (method === 'DELETE') {
        exists = false
        throw new Error('response lost')
      }
      return previous(url, method)
    }
    await expect(registry().retireKnownIdle({ id: 91, name }, remaining)).rejects.toMatchObject({ uncertain: true })
    expect(exists).toBe(false)
  })
  it('rejects idle retirement before deletion if original authority changed', async () => {
    onlineIdle()
    const previous = reply
    reply = (url, method) => (url.pathname === '/repositories/21' ? { ...repository, id: 22 } : previous(url, method))
    await expect(registry().retireKnownIdle({ id: 91, name }, remaining)).rejects.toThrow()
    expect(journal).not.toHaveBeenCalled()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('does not dispatch idle deletion when its durable mutation guard fails', async () => {
    onlineIdle()
    journal.mockRejectedValue(new Error('lease lost'))
    await expect(registry().retireKnownIdle({ id: 91, name }, remaining)).rejects.toThrow('lease lost')
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(exists).toBe(true)
  })
  it('makes the runner identity immutable while allowing one delivery attempt', async () => {
    const jit = new JitRegistration({ id: 91, name }, 'c2VjcmV0')
    expect(() => Object.assign(jit, { name: other })).toThrow()
    expect(jit.name).toBe(name)
  })
  it('delivers private JIT once and retains the attempted flag after a failed upload', async () => {
    const jit = new JitRegistration({ id: 91, name }, 'c2VjcmV0'),
      deliver = jest.fn(async () => {
        throw new Error('lost response')
      })
    const executor = { deliverJit: deliver } as unknown as WorkerExecutor
    await expect(jit.deliver(executor)).rejects.toThrow('lost response')
    await expect(jit.deliver(executor)).rejects.toThrow('already attempted')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(name, 'c2VjcmV0', undefined)
  })
  it('requires a complete selected group ACL matching the installed repository set', async () => {
    expect(await registry(orgScope).authority(true)).toEqual(new Set(['repo']))
  })
  it.each([
    { visibility: 'all' },
    { inherited: true },
    { restricted_to_workflows: true },
    { allows_public_repositories: true },
  ])('denies an unsafe group policy %j before mutation', async (change) => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4') ? { ...group, ...change } : previous(url, method)
    await expect(registry(orgScope).authority(true)).rejects.toThrow('selected-repository policy')
    expect(journal).not.toHaveBeenCalled()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('denies an extra uninstalled repository in the group before mutation', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4/repositories')
        ? { total_count: 2, repositories: [repository, { ...repository, id: 22 }] }
        : previous(url, method)
    await expect(registry(orgScope).authority(true)).rejects.toThrow('authorization changed')
    expect(journal).not.toHaveBeenCalled()
  })
  it('denies private-only group admission when public repositories are enabled', async () => {
    await expect(registry({ ...orgScope, allowPrivate: true, allowPublic: true }).authority(true)).rejects.toThrow(
      'selected-repository policy',
    )
    expect(journal).not.toHaveBeenCalled()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('accepts a group whose public policy matches the enabled connection', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4') ? { ...group, allows_public_repositories: true } : previous(url, method)
    expect(await registry({ ...orgScope, allowPrivate: true, allowPublic: true }).authority(true)).toEqual(
      new Set(['repo']),
    )
  })
  it('requires opt-in for a public repository', async () => {
    const scope: RunnerScope = {
      kind: 'repository',
      repository: { ...repository, private: false },
      allowPrivate: true,
      allowPublic: false,
    }
    reply = () => ({ ...repository, private: false })
    await expect(registry(scope).authority(true)).rejects.toThrow('Public repository')
    expect(journal).not.toHaveBeenCalled()
  })
})
