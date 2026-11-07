/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstallationBinding, InstallationCatalog } from './catalog'
import { ListenerCredentials } from './credentials'
import { GitHubAppSource } from './github-app'
import { GitHubRepository } from './jobs'
import { SqliteStateDatabase } from './state/sqlite'
import { ExecutionLease, ListenerState } from './state/store'

describe('CI shared installation directory', () => {
  const originalFetch = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    lease: ExecutionLease,
    binding: InstallationBinding,
    provider: ListenerCredentials,
    catalog: InstallationCatalog,
    app: GitHubAppSource,
    repositories: GitHubRepository[],
    selected: GitHubRepository[],
    group: Record<string, unknown>,
    countChange: boolean,
    failClose: boolean,
    calls: { path: string; method: string; body?: Record<string, unknown> }[],
    groupExists: boolean,
    duplicateGroup: boolean,
    denyWrite: boolean,
    readbackMismatch: boolean,
    failAfterWrite: string | undefined,
    authorize: jest.Mock<Promise<void>, [unknown]>
  let gate: { entered(): void; wait: Promise<void> } | undefined
  const make = (allowPublic = false) => {
    provider = new ListenerCredentials(state, lease, 'catalog/1', {
      kind: 'app',
      app,
      installation: binding.installation,
    })
    return new InstallationCatalog(provider, binding, { allowPublic, group: 'boxlite-ci-runner' }, authorize)
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-catalog-'))
    db = new SqliteStateDatabase(directory)
    state = new ListenerState(db, 'app:' + randomUUID())
    await state.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    binding = {
      binding: 'original-binding',
      generation: 1,
      organization: 'tenant',
      actor: 'original-actor',
      installation: {
        id: 1,
        account: { id: 7, login: 'owner', type: 'User' },
        suspended: false,
        permissions: { metadata: 'read', organization_self_hosted_runners: 'write' },
      },
    }
    repositories = [21, 22].map((id) => ({ id, owner: { id: 7, login: 'owner' }, name: 'repo' + id, private: true }))
    selected = repositories
    group = {
      id: 5,
      default: false,
      name: 'boxlite-ci-runner',
      visibility: 'selected',
      inherited: false,
      restricted_to_workflows: false,
      allows_public_repositories: false,
    }
    countChange = failClose = false
    groupExists = true
    duplicateGroup = denyWrite = readbackMismatch = false
    failAfterWrite = undefined
    authorize = jest.fn(async (_effect: unknown) => {})
    gate = undefined
    calls = []
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input)),
        path = url.pathname,
        body = options?.body ? JSON.parse(String(options.body)) : undefined,
        method = options?.method || 'GET'
      calls.push({ path, method, body })
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (denyWrite && method !== 'GET' && path.startsWith('/orgs/')) return json({}, 403)
      if (path === '/app/installations/1') return json({ ...binding.installation, suspended_at: null })
      if (path.endsWith('/access_tokens'))
        return json(
          {
            token: 'test-private-catalog-token',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { ...body.permissions, metadata: 'read' },
          },
          201,
        )
      if (path === '/installation/token') return failClose ? json({}, 503) : new Response(null, { status: 204 })
      const page = Number(url.searchParams.get('page'))
      if (path === '/installation/repositories') {
        gate?.entered()
        if (gate) await gate.wait
        return json({
          total_count: repositories.length + (countChange && page === 2 ? 1 : 0),
          repositories: repositories.slice((page - 1) * 100, page * 100),
        })
      }
      if (path === '/orgs/owner/actions/runner-groups' && method === 'POST') {
        groupExists = true
        Object.assign(group, body)
        selected = repositories.filter((repository) => body.selected_repository_ids.includes(repository.id))
      } else if (path === '/orgs/owner/actions/runner-groups/5' && method === 'PATCH') Object.assign(group, body)
      else if (path === '/orgs/owner/actions/runner-groups/5/repositories' && method === 'PUT') {
        selected = repositories.filter((repository) => body.selected_repository_ids.includes(repository.id))
      }
      if (['POST', 'PATCH', 'PUT'].includes(method) && path.startsWith('/orgs/')) {
        if (failAfterWrite === method) {
          failAfterWrite = undefined
          return json({}, 500)
        }
        return method === 'PUT' ? new Response(null, { status: 204 }) : json(group, method === 'POST' ? 201 : 200)
      }
      if (path === '/orgs/owner/actions/runner-groups') {
        const groups = groupExists ? [group] : []
        if (duplicateGroup) groups.push({ ...group, id: 6 })
        return json({ total_count: groups.length, runner_groups: groups })
      }
      if (path === '/orgs/owner/actions/runner-groups/5')
        return json(
          readbackMismatch ? { ...group, allows_public_repositories: !group.allows_public_repositories } : group,
        )
      if (path === '/orgs/owner/actions/runner-groups/5/repositories')
        return json({ total_count: selected.length, repositories: selected })
      throw new Error('Unexpected catalog HTTP request')
    }) as typeof fetch
    app = new GitHubAppSource({ issuer: 'test', privateKey: () => keys.privateKey })
    catalog = make()
  })
  afterEach(async () => {
    failClose = false
    await provider.close()
    global.fetch = originalFetch
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  it('creates separate personal repository pools with a metadata-only catalog token', async () => {
    const scopes = await catalog.load()
    expect(scopes.map((scope) => scope.runners.kind === 'repository' && scope.runners.repository.id)).toEqual([21, 22])
    expect(scopes.every((scope) => scope.actor === 'original-actor' && scope.installation.id === 1)).toBe(true)
    expect(calls.find((call) => call.path.endsWith('/access_tokens'))?.body).toEqual({
      permissions: { metadata: 'read' },
    })
    expect(calls.some((call) => call.path.startsWith('/orgs/'))).toBe(false)
    expect(JSON.stringify(await state.recover(lease))).not.toContain('test-private-catalog-token')
  })
  it('filters public repositories when public execution is disabled', async () => {
    repositories[1].private = false
    expect(await catalog.load()).toHaveLength(1)
  })
  it('shares one selected organization group across its installed repositories', async () => {
    binding.installation.account.type = 'Organization'
    catalog = make()
    const scopes = await catalog.load()
    expect(scopes).toHaveLength(1)
    expect(scopes[0].runners).toEqual({
      kind: 'organization',
      account: { id: 7, login: 'owner' },
      group: 5,
      repositories: [21, 22],
      allowPublic: false,
    })
    expect(calls.filter((call) => call.path.endsWith('/access_tokens')).map((call) => call.body)).toEqual([
      { permissions: { metadata: 'read' } },
      { permissions: { organization_self_hosted_runners: 'write' } },
    ])
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(2)
  })
  it.each([false, true])('synchronizes a mixed organization with allowPublic=%s', async (allowPublic) => {
    binding.installation.account.type = 'Organization'
    repositories[1].private = false
    group.allows_public_repositories = !allowPublic
    catalog = make(allowPublic)
    const scopes = await catalog.load()
    expect(scopes[0].runners).toMatchObject({ repositories: allowPublic ? [21, 22] : [21], allowPublic })
    expect(selected.map((repository) => repository.id)).toEqual(allowPublic ? [21, 22] : [21])
    expect(group.allows_public_repositories).toBe(allowPublic)
    expect(authorize).toHaveBeenCalled()
  })
  it('creates a missing managed organization group', async () => {
    binding.installation.account.type = 'Organization'
    groupExists = false
    catalog = make()
    expect((await catalog.load())[0].runners).toMatchObject({ group: 5, repositories: [21, 22] })
    expect(calls.find((call) => call.method === 'POST' && call.path.endsWith('/runner-groups'))?.body).toMatchObject({
      name: 'boxlite-ci-runner',
      visibility: 'selected',
      selected_repository_ids: [21, 22],
      allows_public_repositories: false,
    })
    expect(authorize).toHaveBeenCalledTimes(1)
  })
  it('repairs managed group membership and narrows broad visibility', async () => {
    binding.installation.account.type = 'Organization'
    selected = [repositories[0], { ...repositories[0], id: 99 }]
    group.visibility = 'all'
    group.restricted_to_workflows = true
    catalog = make()
    expect(await catalog.load()).toHaveLength(1)
    expect(group).toMatchObject({ visibility: 'selected', restricted_to_workflows: false })
    expect(selected.map((repository) => repository.id)).toEqual([21, 22])
  })
  it('clears a managed group when all installed repositories are public and excluded', async () => {
    binding.installation.account.type = 'Organization'
    for (const repository of repositories) repository.private = false
    group.allows_public_repositories = true
    catalog = make()
    expect(await catalog.load()).toEqual([])
    expect(selected).toEqual([])
    expect(group.allows_public_repositories).toBe(false)
  })
  it('refuses to mutate or adopt the default organization group', async () => {
    binding.installation.account.type = 'Organization'
    group.default = true
    catalog = make()
    await expect(catalog.load()).rejects.toThrow('managed')
    expect(authorize).not.toHaveBeenCalled()
  })
  it.each(['all', 'public', 'workflows', 'foreign-repo', 'missing-repo'])(
    'repairs managed policy drift: %s',
    async (kind) => {
      binding.installation.account.type = 'Organization'
      catalog = make()
      if (kind === 'all') group.visibility = 'all'
      if (kind === 'public') group.allows_public_repositories = true
      if (kind === 'workflows') group.restricted_to_workflows = true
      if (kind === 'foreign-repo') selected = [...repositories, { ...repositories[0], id: 99 }]
      if (kind === 'missing-repo') selected = [repositories[0]]
      expect(await catalog.load()).toHaveLength(1)
      expect(group).toMatchObject({
        visibility: 'selected',
        allows_public_repositories: false,
        restricted_to_workflows: false,
      })
      expect(selected.map((repository) => repository.id)).toEqual([21, 22])
      expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(2)
    },
  )
  it.each(['inherited', 'ambiguous'])('rejects an unmanaged organization group: %s', async (kind) => {
    binding.installation.account.type = 'Organization'
    if (kind === 'inherited') group.inherited = true
    else duplicateGroup = true
    catalog = make()
    await expect(catalog.load()).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
  })
  it('does not rewrite an already synchronized group', async () => {
    binding.installation.account.type = 'Organization'
    catalog = make()
    expect(await catalog.load()).toHaveLength(1)
    expect(authorize).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.path.startsWith('/orgs/') && call.method !== 'GET')).toEqual([])
  })
  it('does not create a group without eligible repositories', async () => {
    binding.installation.account.type = 'Organization'
    repositories = []
    groupExists = false
    catalog = make()
    expect(await catalog.load()).toEqual([])
    expect(authorize).not.toHaveBeenCalled()
  })
  it('checks host authorization before a group mutation', async () => {
    binding.installation.account.type = 'Organization'
    selected = []
    authorize.mockRejectedValue(Error('owner revoked'))
    catalog = make()
    await expect(catalog.load()).rejects.toThrow('owner revoked')
    expect(calls.filter((call) => call.path.startsWith('/orgs/') && call.method !== 'GET')).toEqual([])
  })
  it('does not publish a group after GitHub denies a write', async () => {
    binding.installation.account.type = 'Organization'
    selected = []
    denyWrite = true
    catalog = make()
    await expect(catalog.load()).rejects.toMatchObject({ status: 403 })
    expect(selected).toEqual([])
  })
  it('does not publish a group whose policy readback differs', async () => {
    binding.installation.account.type = 'Organization'
    selected = []
    readbackMismatch = true
    catalog = make()
    await expect(catalog.load()).rejects.toThrow('policy')
  })
  it.each(['POST', 'PATCH', 'PUT'])('recovers a lost %s response by reading remote state', async (method) => {
    binding.installation.account.type = 'Organization'
    if (method === 'POST') groupExists = false
    if (method === 'PATCH') group.allows_public_repositories = true
    if (method === 'PUT') selected = []
    failAfterWrite = method
    catalog = make()
    await expect(catalog.load()).rejects.toMatchObject({ status: 500 })
    const afterFailure = calls.length
    expect(await catalog.load()).toHaveLength(1)
    const next = calls.slice(afterFailure).filter((call) => call.path.startsWith('/orgs/'))
    expect(next[0]).toMatchObject({ method: 'GET', path: '/orgs/owner/actions/runner-groups' })
    expect(group).toMatchObject({ visibility: 'selected', allows_public_repositories: false })
    expect(selected.map((repository) => repository.id)).toEqual([21, 22])
    expect(calls.filter((call) => call.path.startsWith('/orgs/') && call.method === method)).toHaveLength(1)
  })
  it('does not admit transferred repositories even when a catalog response lists them', async () => {
    repositories[0].owner.id = 8
    await expect(catalog.load()).rejects.toThrow('installation account')
  })
  it.each(['duplicate', 'changing-count'])('rejects %s across catalog pages', async (kind) => {
    repositories = Array.from({ length: 101 }, (_, i) => ({ ...repositories[0], id: i + 21, name: 'repo' + i }))
    if (kind === 'duplicate') repositories[100].id = repositories[0].id
    else countChange = true
    await expect(catalog.load()).rejects.toThrow()
    expect(calls.filter((call) => call.path === '/installation/repositories')).toHaveLength(2)
  })
  it('does not request organization credentials before catalog retirement succeeds', async () => {
    binding.installation.account.type = 'Organization'
    catalog = make()
    failClose = true
    await expect(catalog.load()).rejects.toThrow()
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(1)
    expect(calls.some((call) => call.path.startsWith('/orgs/'))).toBe(false)
  })
  it('snapshots binding identity before asynchronous inventory reads', async () => {
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
      }),
      wait = new Promise<void>((resolve) => {
        resume = resolve
      })
    gate = { entered, wait }
    const pending = catalog.load()
    await started
    binding.actor = 'changed'
    binding.installation.account.id = 8
    resume()
    const scopes = await pending
    expect(scopes[0].actor).toBe('original-actor')
    expect(scopes[0].installation.account.id).toBe(7)
  })
})
