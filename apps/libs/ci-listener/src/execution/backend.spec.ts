/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialSource } from '../credentials'
import { GitHubAppSource, GitHubInstallation } from '../github-app'
import { LeaseLost } from '../state/database'
import { SqliteStateDatabase } from '../state/sqlite'
import { ExecutionLease, ListenerState } from '../state/store'
import { GitHubExecutionBackend, ExecutionHost } from './backend'
import { ExecutionJournal } from './journal'
import { ExecutionScope } from './model'

describe('CI shared execution authority', () => {
  const originalFetch = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    name = 'ci-jit-' + 'a'.repeat(32),
    notice = { repository: 21, run: 33, job: 55 }
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    lease: ExecutionLease,
    scope: ExecutionScope,
    source: CredentialSource,
    backend: GitHubExecutionBackend,
    host: ExecutionHost,
    namespace: string,
    revoked: boolean,
    takeover: boolean
  let repository: { id: number; owner: { id: number; login: string }; name: string; private: boolean }
  let selected: (typeof repository)[]
  let runners: { id: number; name: string }[], calls: { path: string; method: string; body?: Record<string, unknown> }[]
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-backend-'))
    db = new SqliteStateDatabase(directory)
    namespace = 'app:' + randomUUID()
    state = new ListenerState(db, namespace)
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    repository = { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true }
    selected = [repository]
    scope = {
      binding: 'binding',
      generation: 1,
      organization: 'tenant',
      actor: 'actor',
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
      runners: { kind: 'repository', repository: structuredClone(repository), allowPublic: false },
    }
    await journal.define(lease, scope)
    const installation: GitHubInstallation = {
      ...scope.installation,
      account: { ...scope.installation.account },
      permissions: { metadata: 'read', actions: 'read', administration: 'write' },
      suspended: false,
    }
    revoked = takeover = false
    runners = []
    calls = []
    global.fetch = jest.fn(async (input, options) => {
      const path = new URL(String(input)).pathname,
        method = options?.method ?? 'GET',
        body = options?.body ? JSON.parse(String(options.body)) : undefined
      calls.push({ path, method, body })
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (path === '/app/installations/1') return json({ ...installation, suspended_at: null })
      if (path === '/app/installations/1/access_tokens')
        return json(
          {
            token: 'private-test-credential',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { ...body.permissions, metadata: 'read' },
            ...(body.repository_ids ? { repositories: body.repository_ids.map((id: number) => ({ id })) } : {}),
          },
          201,
        )
      if (path === '/installation/token') return new Response(null, { status: 204 })
      if (path === '/repositories/21') return json(repository)
      if (path === '/repositories/22') return json(selected.find((item) => item.id === 22))
      if (path === '/orgs/owner') return json({ id: 7, login: 'owner' })
      if (path === '/orgs/owner/actions/runner-groups/5')
        return json({
          id: 5,
          visibility: 'selected',
          inherited: false,
          restricted_to_workflows: false,
          allows_public_repositories: false,
        })
      if (path === '/orgs/owner/actions/runner-groups/5/repositories')
        return json({ total_count: selected.length, repositories: selected })
      if (path === '/repos/owner/repo2/actions/jobs/56')
        return json({
          id: 56,
          run_id: 34,
          status: 'queued',
          labels: ['boxlite-ci-runner'],
          runner_id: null,
          conclusion: null,
          completed_at: null,
        })
      if (path === '/repos/owner/repo/actions/jobs/55')
        return json({
          id: 55,
          run_id: 33,
          status: 'queued',
          labels: ['boxlite-ci-runner'],
          runner_id: null,
          conclusion: null,
          completed_at: null,
        })
      if (path === '/repos/owner/repo/actions/runs')
        return json({ total_count: 1, workflow_runs: [{ id: 33, repository: { id: 21 } }] })
      if (path === '/repos/owner/repo/actions/runs/33/jobs')
        return json({
          total_count: 1,
          jobs: [
            {
              id: 55,
              run_id: 33,
              status: 'queued',
              labels: ['boxlite-ci-runner'],
              runner_id: null,
              conclusion: null,
              completed_at: null,
            },
          ],
        })
      if (path === '/repos/owner/repo/actions/runners') return json({ total_count: runners.length, runners })
      if (path.endsWith('/generate-jitconfig')) {
        const runner = { id: 91, name: body.name }
        runners.push(runner)
        return json({ runner, encoded_jit_config: 'c2VjcmV0' }, 201)
      }
      if (path === '/repos/owner/repo/actions/runners/91' && method === 'DELETE') {
        runners = []
        return new Response(null, { status: 204 })
      }
      throw new Error('Unexpected GitHub test request: ' + path)
    }) as typeof fetch
    source = {
      kind: 'app',
      app: new GitHubAppSource({ issuer: 'test', privateKey: () => keys.privateKey }),
      installation,
    }
    host = {
      authorize: jest.fn(async (_original, operation) => {
        if (revoked && operation === 'admission') throw new Error('Admission revoked')
        if (takeover) {
          takeover = false
          await db.transaction(namespace, async (tx) => {
            const row = (await tx.get('@owner', true))!
            const payload = row.payload as { epoch: number }
            await tx.put(
              { ...row, version: randomUUID(), payload: { ...(row.payload as object), epoch: payload.epoch + 1 } },
              row.version,
            )
          })
        }
      }),
      workers: {
        create: jest.fn(async () => ({ box_id: 'original-box', status: 'running' })),
        get: jest.fn(async () => ({ box_id: 'original-box', status: 'running' })),
        stop: jest.fn(async () => {}),
        remove: jest.fn(async () => {}),
        deliverJit: jest.fn(async () => {}),
      },
    }
    backend = makeBackend()
  })
  const makeBackend = () => new GitHubExecutionBackend(state, lease, scope, source, host, ['boxlite-ci-runner'])
  afterEach(async () => {
    await backend.close().catch(() => {})
    global.fetch = originalFetch
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const launch = () => ({ name, image: 'runner', cpus: 2, memoryMiB: 2048, entrypoint: ['bash', '-c', 'run'] })
  const useOrganization = async () => {
    await backend.close()
    if (source.kind !== 'app') throw new Error('Invalid test setup')
    scope.installation.account.type = source.installation.account.type = 'Organization'
    source.installation.permissions.organization_self_hosted_runners = 'write'
    selected.push({ id: 22, name: 'repo2', owner: { id: 7, login: 'owner' }, private: true })
    scope.runners = {
      kind: 'organization',
      account: { id: 7, login: 'owner' },
      group: 5,
      repositories: [21, 22],
      allowPublic: false,
    }
    await new ExecutionJournal(state).define(lease, scope)
    backend = makeBackend()
  }
  it('reads both installed repositories using separate Actions-only tokens for one organization scope', async () => {
    await useOrganization()
    expect((await backend.job(notice)).repository).toBe(21)
    expect((await backend.job({ repository: 22, run: 34, job: 56 })).repository).toBe(22)
    expect(calls.filter((call) => call.path.endsWith('/access_tokens')).map((call) => call.body)).toEqual([
      { permissions: { actions: 'read' }, repository_ids: [21] },
      { permissions: { actions: 'read' }, repository_ids: [22] },
    ])
  })
  it('uses organization runner credentials and validates the selected repository group before JIT registration', async () => {
    await useOrganization()
    const guard = jest.fn(async () => {}),
      session = await backend.runners(guard)
    expect((await session.registry.create(name)).id).toBe(91)
    expect(calls.find((call) => call.path.endsWith('/access_tokens'))?.body).toEqual({
      permissions: { organization_self_hosted_runners: 'write' },
    })
    expect(calls.find((call) => call.path.endsWith('/generate-jitconfig'))).toMatchObject({
      path: '/orgs/owner/actions/runners/generate-jitconfig',
      body: { runner_group_id: 5 },
    })
    expect(guard).toHaveBeenCalledWith({ kind: 'register', name })
    await session.close()
  })
  it('rejects an added repository in the organization group before journaling or registering', async () => {
    await useOrganization()
    selected.push({ ...repository, id: 23, name: 'outside' })
    const guard = jest.fn(async () => {}),
      session = await backend.runners(guard)
    await expect(session.registry.create(name)).rejects.toThrow('authorization changed')
    expect(guard).not.toHaveBeenCalled()
    expect(calls.some((call) => call.path.endsWith('/generate-jitconfig'))).toBe(false)
    await session.close()
  })
  it.each(['installation', 'account', 'login', 'type'])('rejects a mismatched App %s before HTTP', (field) => {
    if (source.kind !== 'app') throw new Error('Invalid test setup')
    if (field === 'installation') source.installation.id = 2
    if (field === 'account') source.installation.account.id = 8
    if (field === 'login') source.installation.account.login = 'another'
    if (field === 'type') source.installation.account.type = 'Organization'
    expect(makeBackend).toThrow('original execution scope')
    expect(calls).toEqual([])
  })
  it('rejects a PAT for an App scope without reading the secret', () => {
    const token = jest.fn(() => 'private-pat')
    source = { kind: 'pat', repository: 21, token }
    expect(makeBackend).toThrow('original execution scope')
    expect(token).not.toHaveBeenCalled()
  })
  it('reads the original job with an Actions-only repository token and retires it', async () => {
    expect(await backend.job(notice)).toMatchObject({ ...notice, status: 'queued' })
    expect(calls.find((call) => call.path.endsWith('/access_tokens'))?.body).toEqual({
      permissions: { actions: 'read' },
      repository_ids: [21],
    })
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
    expect(JSON.stringify(await state.recover(lease))).not.toContain('private-test-credential')
  })
  it('rejects an outside repository before any authority or HTTP request', async () => {
    await expect(backend.job({ ...notice, repository: 22 })).rejects.toThrow('outside')
    expect(host.authorize).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('bounds compensation to one authorized repository using an Actions-only token', async () => {
    expect(await backend.queued(21)).toEqual([
      { ...notice, status: 'queued', labels: ['boxlite-ci-runner'], runner: null },
    ])
    expect(calls.filter((call) => call.path === '/repos/owner/repo/actions/runs')).toHaveLength(5)
    expect(calls.find((call) => call.path.endsWith('/access_tokens'))?.body).toEqual({
      permissions: { actions: 'read' },
      repository_ids: [21],
    })
    await expect(backend.queued(22)).rejects.toThrow('outside')
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(1)
  })
  it('rejects a transferred repository and retires the issued token', async () => {
    repository.owner.id = 8
    await expect(backend.job(notice)).rejects.toThrow('authority changed')
    expect(calls.some((call) => call.path.includes('/jobs/'))).toBe(false)
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
  })
  it('denies new Box and JIT effects after revocation but permits original-resource cleanup', async () => {
    const session = await backend.runners(async () => {})
    const runner = await session.registry.create(name)
    revoked = true
    await expect(backend.workers.create(launch())).rejects.toThrow('revoked')
    await expect(backend.workers.deliverJit(name, 'c2VjcmV0')).rejects.toThrow('revoked')
    await expect(session.registry.create('ci-jit-' + 'b'.repeat(32))).rejects.toThrow('revoked')
    await backend.workers.stop(name)
    await backend.workers.remove(name)
    await session.registry.remove(runner)
    expect(host.workers.create).not.toHaveBeenCalled()
    expect(host.workers.deliverJit).not.toHaveBeenCalled()
    expect(host.workers.stop).toHaveBeenCalledWith(name)
    expect(runners).toEqual([])
    expect(calls.filter((call) => call.path.endsWith('/generate-jitconfig'))).toHaveLength(1)
    await session.close()
  })
  it('checks the execution epoch after the asynchronous host check before Box effects', async () => {
    takeover = true
    await expect(backend.workers.create(launch())).rejects.toBeInstanceOf(LeaseLost)
    expect(host.workers.create).not.toHaveBeenCalled()
  })
  it('checks the epoch after the journal callback before GitHub mutation', async () => {
    const session = await backend.runners(async () => {
      takeover = true
      await host.authorize(scope, 'cleanup')
    })
    await expect(session.registry.create(name)).rejects.toBeInstanceOf(LeaseLost)
    expect(calls.some((call) => call.path.endsWith('/generate-jitconfig'))).toBe(false)
    await session.close().catch(() => {})
  })
  it('does not allow caller mutation during a host check to change scope or launch', async () => {
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve
      })
    jest.mocked(host.authorize).mockImplementationOnce(async (original) => {
      entered()
      await gate
      original.actor = 'modified-host-copy'
    })
    const input = launch(),
      pending = backend.workers.create(input)
    await started
    input.entrypoint[0] = 'changed'
    scope.actor = 'changed-caller'
    resume()
    await pending
    expect(host.workers.create).toHaveBeenCalledWith(expect.objectContaining({ entrypoint: ['bash', '-c', 'run'] }))
    await backend.admit()
    expect(jest.mocked(host.authorize).mock.calls.at(-1)?.[0].actor).toBe('actor')
  })
})
