/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubAppSource } from './github-app'
import { ListenerCredentials } from './credentials'
import { ExecutionLease, ListenerState } from './state/store'
import { SqliteStateDatabase } from './state/sqlite'

describe('CI shared credential ownership', () => {
  const original = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const installation = {
    id: 7,
    account: { id: 8, login: 'owner', type: 'User' },
    permissions: { metadata: 'read', actions: 'read', administration: 'write' },
    suspended_at: null,
  }
  let directory: string,
    namespace: string,
    lease: ExecutionLease,
    db: SqliteStateDatabase,
    state: ListenerState,
    provider: ListenerCredentials
  let clock: number,
    issued: number,
    failClose: number,
    failIssue: boolean,
    calls: { path: string; method: string; authorization: string }[]
  let issueGate: { entered: () => void; wait: Promise<void> } | undefined
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-credentials-'))
    db = new SqliteStateDatabase(directory)
    namespace = 'app:' + randomUUID()
    state = new ListenerState(db, namespace)
    await state.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    clock = Date.now()
    issued = 0
    failClose = 0
    failIssue = false
    calls = []
    issueGate = undefined
    global.fetch = jest.fn(async (input, options) => {
      const path = new URL(String(input)).pathname,
        method = options?.method ?? 'GET',
        authorization = (options?.headers as Record<string, string>).Authorization
      calls.push({ path, method, authorization })
      if (path === '/app/installations/7') return new Response(JSON.stringify(installation))
      if (path.endsWith('/access_tokens')) {
        const stored = await db.transaction(namespace, (tx) => tx.page('', 100))
        expect(
          stored.some(
            (row) => row.key.startsWith('credential/') && (row.payload as { phase: string }).phase === 'requested',
          ),
        ).toBe(true)
        issueGate?.entered()
        if (issueGate) await issueGate.wait
        if (failIssue) throw new Error('unknown issue response')
        const request = JSON.parse(String(options?.body))
        issued++
        return new Response(
          JSON.stringify({
            token: 'test-private-token-' + issued,
            expires_at: new Date(clock + 3600000).toISOString(),
            permissions: { ...request.permissions, metadata: 'read' },
            ...(request.repository_ids ? { repositories: request.repository_ids.map((id: number) => ({ id })) } : {}),
          }),
          { status: 201 },
        )
      }
      if (path === '/installation/token')
        return failClose-- > 0 ? new Response('{}', { status: 503 }) : new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 55 }))
    }) as typeof fetch
    const app = new GitHubAppSource({ issuer: 'test-app', privateKey: () => keys.privateKey, now: () => clock })
    provider = new ListenerCredentials(state, lease, 'scope/test', {
      kind: 'app',
      app,
      installation: await app.installation(7),
    })
  })
  afterEach(async () => {
    failClose = 0
    await provider.close().catch(() => {})
    global.fetch = original
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const posts = () => calls.filter((call) => call.path.endsWith('/access_tokens'))
  const deletes = () => calls.filter((call) => call.path === '/installation/token')
  it('journals issuance before HTTP and retires its exact private credential', async () => {
    const borrow = await provider.open({ kind: 'jobs', repository: 11 })
    expect(await borrow.credential.request('/repos/owner/repo/actions/jobs/55')).toEqual({ id: 55 })
    const rows = await db.transaction(namespace, (tx) => tx.page('', 100))
    expect(JSON.stringify(rows)).not.toContain('test-private-token-')
    expect(rows.filter((row) => row.key.startsWith('credential/'))).toHaveLength(1)
    await borrow.close()
    expect(deletes().map((call) => call.authorization)).toEqual(['Bearer test-private-token-1'])
    expect(
      (await db.transaction(namespace, (tx) => tx.page('', 100))).filter((row) => row.key.startsWith('credential/')),
    ).toEqual([])
  })
  it('rejects a second borrower while the same purpose is active', async () => {
    const borrow = await provider.open({ kind: 'jobs', repository: 11 })
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toThrow('already in use')
    expect(posts()).toHaveLength(1)
    await borrow.close()
  })
  it('retries failed retirement before minting a replacement', async () => {
    const borrow = await provider.open({ kind: 'jobs', repository: 11 })
    failClose = 2
    await expect(borrow.close()).rejects.toThrow()
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toThrow()
    expect(posts()).toHaveLength(1)
    const next = await provider.open({ kind: 'jobs', repository: 11 })
    expect(next.credential.usable).toBe(true)
    expect(posts()).toHaveLength(2)
    await next.close()
  })
  it('does not let a stale borrow close a replacement credential', async () => {
    const first = await provider.open({ kind: 'jobs', repository: 11 })
    failClose = 1
    await expect(first.close()).rejects.toThrow()
    const second = await provider.open({ kind: 'jobs', repository: 11 })
    await first.close()
    expect(second.credential.usable).toBe(true)
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toThrow('already in use')
    await second.close()
  })
  it('shares concurrent retirement of one borrow instead of deleting its record twice', async () => {
    const borrow = await provider.open({ kind: 'jobs', repository: 11 })
    await Promise.all([borrow.close(), borrow.close()])
    expect(deletes()).toHaveLength(1)
  })
  it('retries durable retirement after revocation succeeded but deletion failed', async () => {
    const borrow = await provider.open({ kind: 'jobs', repository: 11 })
    const commit = jest.spyOn(state, 'commit').mockRejectedValueOnce(new Error('retirement commit failed'))
    await expect(borrow.close()).rejects.toThrow('retirement commit failed')
    expect(deletes()).toHaveLength(1)
    expect(
      (await db.transaction(namespace, (tx) => tx.page('', 100))).some((row) => row.key.startsWith('credential/')),
    ).toBe(true)
    commit.mockRestore()
    await provider.close()
    expect(
      (await db.transaction(namespace, (tx) => tx.page('', 100))).filter((row) => row.key.startsWith('credential/')),
    ).toEqual([])
    expect(deletes()).toHaveLength(1)
  })
  it('renews by retiring an expired local window and issuing a fresh credential', async () => {
    const first = await provider.open({ kind: 'jobs', repository: 11 })
    clock += 61000
    expect(first.credential.usable).toBe(false)
    await first.close()
    const second = await provider.open({ kind: 'jobs', repository: 11 })
    expect(second.credential.usable).toBe(true)
    expect(posts()).toHaveLength(2)
    await second.close()
  })
  it('retains an unknown issuance intent and defers an immediate remint', async () => {
    failIssue = true
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toMatchObject({ uncertain: true })
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toThrow('deferred')
    expect(posts()).toHaveLength(1)
    const rows = await db.transaction(namespace, (tx) => tx.page('', 100))
    expect(
      rows.filter((row) => row.key.startsWith('credential/')).map((row) => (row.payload as { phase: string }).phase),
    ).toEqual(['requested'])
  })
  it('retires a late token response after the provider was closed', async () => {
    let entered!: () => void, release!: () => void
    const entering = new Promise<void>((resolve) => {
        entered = resolve
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve
      })
    issueGate = { entered, wait }
    const pending = provider.open({ kind: 'jobs', repository: 11 })
    await entering
    await provider.close()
    release()
    await expect(pending).rejects.toThrow('provider is closed')
    expect(deletes()).toHaveLength(1)
    await expect(provider.open({ kind: 'jobs', repository: 11 })).rejects.toThrow('provider is closed')
  })
  it('never forwards a personal token outside its pinned repository or revokes it', async () => {
    await provider.close()
    provider = new ListenerCredentials(state, lease, 'scope/pat', {
      kind: 'pat',
      repository: 11,
      token: () => 'test-personal-token',
    })
    await expect(provider.open({ kind: 'jobs', repository: 12 })).rejects.toThrow('pinned repository')
    await expect(provider.open({ kind: 'organization-runners' })).rejects.toThrow('pinned repository')
    const borrow = await provider.open({ kind: 'repository-runners', repository: 11 })
    expect(await borrow.credential.request('/repos/owner/repo')).toEqual({ id: 55 })
    await borrow.close()
    expect(posts()).toHaveLength(0)
    expect(deletes()).toHaveLength(0)
  })
})
