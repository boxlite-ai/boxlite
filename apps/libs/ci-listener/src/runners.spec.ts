/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubCredential } from './github-app'
import { GitHubRunners, RunnerScope } from './runners'
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
      ['self-hosted', 'linux', 'x64', 'boxlite-ci-runner'],
      journal,
    )
  it('registers in the original repository only after durable intent admission', async () => {
    const jit = await registry().create(name)
    expect({ id: jit.id, name: jit.name, usable: jit.usable }).toEqual({ id: 91, name, usable: true })
    expect(journal).toHaveBeenCalledWith({ kind: 'register', name })
    expect(calls.find((call) => call.method === 'POST')).toEqual({
      route: '/repos/owner/repo/actions/runners/generate-jitconfig',
      method: 'POST',
      json: {
        name,
        runner_group_id: 1,
        labels: ['self-hosted', 'linux', 'x64', 'boxlite-ci-runner'],
        work_folder: '_work',
      },
    })
    expect(() => JSON.stringify(jit)).toThrow('memory-only')
  })
  it('does not register when the host denies the mutation', async () => {
    journal.mockRejectedValue(new Error('execution lease expired'))
    await expect(registry().create(name)).rejects.toThrow('lease expired')
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('retains a known runner identity when the JIT configuration is malformed', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/generate-jitconfig')
        ? { runner: { id: 91, name }, encoded_jit_config: 'unsafe-value' }
        : previous(url, method)
    const jit = await registry().create(name)
    expect(jit.id).toBe(91)
    expect(jit.usable).toBe(false)
  })
  it('makes the runner identity immutable while allowing one delivery attempt', async () => {
    const jit = await registry().create(name)
    expect(() => Object.assign(jit, { name: other })).toThrow()
    expect(jit.name).toBe(name)
  })
  it('delivers private JIT once and retains the attempted flag after a failed upload', async () => {
    const jit = await registry().create(name),
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
    expect((await registry(orgScope).create(name)).id).toBe(91)
    expect(calls.find((call) => call.method === 'POST')?.json).toMatchObject({ runner_group_id: 4 })
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
    await expect(registry(orgScope).create(name)).rejects.toThrow('selected-repository policy')
    expect(journal).not.toHaveBeenCalled()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('denies an extra uninstalled repository in the group before mutation', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4/repositories')
        ? { total_count: 2, repositories: [repository, { ...repository, id: 22 }] }
        : previous(url, method)
    await expect(registry(orgScope).create(name)).rejects.toThrow('authorization changed')
    expect(journal).not.toHaveBeenCalled()
  })
  it('denies private-only group admission when public repositories are enabled', async () => {
    await expect(registry({ ...orgScope, allowPrivate: true, allowPublic: true }).create(name)).rejects.toThrow(
      'selected-repository policy',
    )
    expect(journal).not.toHaveBeenCalled()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('accepts a group whose public policy matches the enabled connection', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.endsWith('/runner-groups/4') ? { ...group, allows_public_repositories: true } : previous(url, method)
    expect((await registry({ ...orgScope, allowPrivate: true, allowPublic: true }).create(name)).id).toBe(91)
  })
  it('requires opt-in for a public repository', async () => {
    const scope: RunnerScope = {
      kind: 'repository',
      repository: { ...repository, private: false },
      allowPrivate: true,
      allowPublic: false,
    }
    reply = () => ({ ...repository, private: false })
    await expect(registry(scope).create(name)).rejects.toThrow('Public repository')
    expect(journal).not.toHaveBeenCalled()
  })
  it('does not infer absence from a hidden 404 or partial inventory', async () => {
    const previous = reply
    for (const value of [new Response('', { status: 404 }), { total_count: 2, runners: [{ id: 91, name }] }]) {
      reply = (url, method) => (url.pathname.endsWith('/actions/runners') ? value : previous(url, method))
      await expect(registry().lookup({ id: 91, name })).rejects.toThrow()
    }
  })
  it('does not delete a renamed runner or adopt a same-name runner with another known ID', async () => {
    await expect(registry().remove({ id: 91, name: other })).rejects.toThrow('renamed')
    expect(await registry().lookup({ id: 92, name })).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  it('removes only the known original ID and confirms its absence through enumeration', async () => {
    await registry().remove({ id: 91, name })
    expect(journal).toHaveBeenCalledWith({ kind: 'remove', id: 91, name })
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.route)).toEqual([
      '/repos/owner/repo/actions/runners/91',
    ])
    expect(calls.filter((call) => call.route.endsWith('/actions/runners'))).toHaveLength(2)
  })
  it('captures original removal identity before the asynchronous journal callback', async () => {
    const identity = { id: 91, name },
      previous = reply
    journal.mockImplementation(async () => {
      identity.id = 92
      identity.name = other
    })
    reply = (url, method) => {
      if (method === 'DELETE') {
        if (url.pathname.endsWith('/91')) exists = false
        return new Response(null, { status: 204 })
      }
      return previous(url, method)
    }
    await registry().remove(identity)
    expect(journal).toHaveBeenCalledWith({ kind: 'remove', id: 91, name })
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.route)).toEqual([
      '/repos/owner/repo/actions/runners/91',
    ])
    expect(exists).toBe(false)
  })
  it('captures original removal identity before asynchronous authority lookup', async () => {
    const identity = { id: 91, name },
      previous = reply
    reply = (url, method) => {
      if (url.pathname === '/repositories/21') {
        identity.id = 92
        identity.name = other
      }
      if (method === 'DELETE') {
        if (url.pathname.endsWith('/91')) exists = false
        return new Response(null, { status: 204 })
      }
      return previous(url, method)
    }
    await registry().remove(identity)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.route)).toEqual([
      '/repos/owner/repo/actions/runners/91',
    ])
    expect(exists).toBe(false)
  })
  it('captures original lookup identity before asynchronous authority checks', async () => {
    const identity = { id: 91, name },
      previous = reply
    reply = (url, method) => {
      if (url.pathname === '/repositories/21') {
        identity.id = 92
        identity.name = other
      }
      return previous(url, method)
    }
    expect(await registry().lookup(identity)).toEqual({ id: 91, name })
  })
  it('still cleans an original organization runner when the group ACL was revoked', async () => {
    const previous = reply
    reply = (url, method) =>
      url.pathname.includes('runner-groups') ? new Response('', { status: 403 }) : previous(url, method)
    await registry(orgScope).remove({ id: 91, name })
    expect(calls.some((call) => call.route.includes('runner-groups'))).toBe(false)
    expect(exists).toBe(false)
  })
})
