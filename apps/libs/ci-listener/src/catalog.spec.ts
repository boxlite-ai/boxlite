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
    calls: { path: string; body?: { permissions: object } }[]
  let gate: { entered(): void; wait: Promise<void> } | undefined
  const make = () => {
    provider = new ListenerCredentials(state, lease, 'catalog/1', {
      kind: 'app',
      app,
      installation: binding.installation,
    })
    return new InstallationCatalog(provider, binding, { allowPublic: false, group: 'boxlite-ci-runner' })
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
      name: 'boxlite-ci-runner',
      visibility: 'selected',
      inherited: false,
      restricted_to_workflows: false,
      allows_public_repositories: false,
    }
    countChange = failClose = false
    gate = undefined
    calls = []
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input)),
        path = url.pathname,
        body = options?.body ? JSON.parse(String(options.body)) : undefined
      calls.push({ path, body })
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
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
      if (path === '/orgs/owner/actions/runner-groups') return json({ total_count: 1, runner_groups: [group] })
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
  it.each(['all', 'inherited', 'public', 'workflows', 'foreign-repo', 'missing-repo'])(
    'rejects unsafe or incomplete organization policy: %s',
    async (kind) => {
      binding.installation.account.type = 'Organization'
      catalog = make()
      if (kind === 'all') group.visibility = 'all'
      if (kind === 'inherited') group.inherited = true
      if (kind === 'public') group.allows_public_repositories = true
      if (kind === 'workflows') group.restricted_to_workflows = true
      if (kind === 'foreign-repo') selected = [...repositories, { ...repositories[0], id: 99 }]
      if (kind === 'missing-repo') selected = [repositories[0]]
      await expect(catalog.load()).rejects.toThrow()
      expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(2)
    },
  )
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
