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
import { testCapacity } from '../../tests/capacity'
import { ExecutionScope } from './model'
import { WorkerPool } from './pool'

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
      runners: { kind: 'repository', repository: structuredClone(repository), allowPrivate: true, allowPublic: false },
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
          labels: ['boxlite'],
          runner_id: null,
          conclusion: null,
          completed_at: null,
        })
      if (path === '/repos/owner/repo/actions/jobs/55')
        return json({
          id: 55,
          run_id: 33,
          status: 'queued',
          labels: ['boxlite'],
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
              labels: ['boxlite'],
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
  const makeBackend = () => new GitHubExecutionBackend(state, lease, scope, source, host, ['boxlite'])
  afterEach(async () => {
    await backend.close().catch(() => {})
    global.fetch = originalFetch
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const launch = () => ({ name, image: 'runner', cpus: 2, memoryMiB: 2048, entrypoint: ['bash', '-c', 'run'] })
  it('reads the authorized runner inventory and releases the credential borrow', async () => {
    runners.push({
      id: 91,
      name,
      busy: false,
      status: 'online',
      labels: [{ name: 'boxlite' }],
    } as (typeof runners)[number])
    await expect(backend.inventory()).resolves.toEqual([
      { id: 91, name, busy: false, status: 'online', labels: ['boxlite'] },
    ])
    await expect(backend.inventory()).resolves.toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith('/generate-jitconfig'))).toBe(false)
  })
  it('isolates runner credential borrows per worker and retires them independently', async () => {
    const other = 'ci-jit-' + 'b'.repeat(32)
    const [first, second] = await Promise.all([
      backend.runners(async () => {}, undefined, ['boxlite'], name),
      backend.runners(async () => {}, undefined, ['boxlite'], other),
    ])
    await Promise.all([first.close(), second.close()])
    await Promise.all([backend.retire(name), backend.retire(other)])
    const again = await backend.runners(async () => {}, undefined, ['boxlite'], name)
    await again.close()
    await backend.retire(name)
  })
  it('rejects foreign worker names before issuing runner credentials', async () => {
    await expect(backend.runners(async () => {}, undefined, ['boxlite'], 'foreign')).rejects.toThrow(
      'credential isolation',
    )
    expect(calls.some((call) => call.path.endsWith('/access_tokens'))).toBe(false)
  })
  it('retires the issued credential if runner session construction rejects labels', async () => {
    await expect(backend.runners(async () => {}, undefined, [], name)).rejects.toThrow('runner labels')
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(1)
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
    const again = await backend.runners(async () => {}, undefined, ['boxlite'], name)
    await again.close()
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(2)
  })
  it('attempts every worker retirement and retains failed revocation for a later close', async () => {
    const other = 'ci-jit-' + 'b'.repeat(32)
    await backend.runners(async () => {}, undefined, ['boxlite'], name)
    await backend.runners(async () => {}, undefined, ['boxlite'], other)
    const fetcher = global.fetch
    let failed = false
    global.fetch = jest.fn(async (input, options) => {
      if (new URL(String(input)).pathname === '/installation/token' && !failed) {
        failed = true
        return new Response(null, { status: 503 })
      }
      return fetcher(input, options)
    }) as typeof fetch
    await expect(backend.close()).rejects.toThrow('Runner credential retirement is incomplete')
    expect(failed).toBe(true)
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
    expect(await state.recover(lease, 1000, ['credential/'])).toHaveLength(1)
    await backend.close()
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(2)
    expect(await state.recover(lease, 1000, ['credential/'])).toEqual([])
  })
  it('sends the same resource selection to the host and the actual GitHub JIT request', async () => {
    const label = 'boxlite-2vcpu-4gbmem-10gbdisk'
    const fetcher = global.fetch
    global.fetch = jest.fn(async (input, options) => {
      const response = await fetcher(input, options)
      if (new URL(String(input)).pathname === '/repos/owner/repo/actions/jobs/55')
        return new Response(JSON.stringify({ ...(await response.json()), labels: [label] }))
      return response
    }) as typeof fetch
    const journal = new ExecutionJournal(state)
    const key = await journal.define(lease, scope)
    const pool = new WorkerPool(journal, key, async () => backend, {
      image: 'runner',
      cpus: 1,
      memoryMiB: 512,
      labels: ['self-hosted', 'linux', 'x64', 'boxlite'],
    })
    try {
      await pool.tick(lease, testCapacity({ account: 1, tenant: 1 }), notice)
      expect(host.workers.create).toHaveBeenCalledWith(
        expect.objectContaining({ cpus: 2, memoryMiB: 4096, diskGiB: 10 }),
      )
      expect(calls.find((call) => call.path.endsWith('/generate-jitconfig'))?.body?.labels).toEqual([
        'self-hosted',
        'linux',
        'x64',
        label,
      ])
      expect(host.workers.deliverJit).toHaveBeenCalledTimes(1)
    } finally {
      await pool.close()
    }
  })
  it('denies Private repository work before Box creation and JIT delivery when Private is disabled', async () => {
    await backend.close()
    scope.runners.allowPrivate = false
    scope.runners.allowPublic = true
    await new ExecutionJournal(state).define(lease, scope)
    backend = makeBackend()
    await expect(backend.job(notice)).rejects.toThrow('visibility is disabled')
    await expect(backend.workers.create(launch())).rejects.toThrow('visibility is disabled')
    await expect(backend.workers.deliverJit(name, 'c2VjcmV0')).rejects.toThrow('visibility is disabled')
    expect(host.workers.create).not.toHaveBeenCalled()
    expect(host.workers.deliverJit).not.toHaveBeenCalled()
  })
  it.each(['valid', 'revoked', 'missing', 'invalid-name'])(
    'fences undispatched creation by its persisted intent: %s',
    async (scenario) => {
      await backend.close()
      host.rejectUndispatchedCreate = jest.fn(async () => {
        throw Error('creation rejected')
      })
      backend = makeBackend()
      const journal = new ExecutionJournal(state)
      const key = await journal.define(lease, scope)
      const row = await journal.reserve(lease, key, notice, testCapacity({ account: 2, tenant: 2 }))
      if (!row) throw Error('fixture reservation failed')
      const intent = await journal.advance(lease, row.record.key, row.record.version, {
        box: { phase: 'requested', id: null },
        effect: { id: randomUUID(), kind: 'box-create' },
      })
      const workerName = scenario === 'invalid-name' ? 'foreign' : scenario === 'missing' ? name : intent.value.name
      revoked = scenario === 'revoked'
      if (scenario === 'valid')
        await expect(backend.workers.create({ ...launch(), name: workerName })).resolves.toMatchObject({
          box_id: 'original-box',
        })
      else await expect(backend.workers.create({ ...launch(), name: workerName })).rejects.toThrow()
      if (scenario === 'revoked')
        expect(host.rejectUndispatchedCreate).toHaveBeenCalledWith(workerName, intent.value.effect!.id)
      if (scenario !== 'valid') expect(host.workers.create).not.toHaveBeenCalled()
    },
  )
  it('passes authorized cleanup reads and JIT delivery through their distinct authority checks', async () => {
    await expect(backend.workers.get(name)).resolves.toMatchObject({ box_id: 'original-box' })
    await backend.workers.deliverJit(name, 'c2VjcmV0')
    expect(host.authorize).toHaveBeenCalledWith(expect.anything(), 'cleanup', undefined)
    expect(host.authorize).toHaveBeenCalledWith(expect.anything(), 'admission', undefined)
    expect(host.workers.deliverJit).toHaveBeenCalledWith(name, 'c2VjcmV0', undefined)
  })
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
      allowPrivate: true,
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
    expect(await backend.queued(21)).toEqual([{ ...notice, status: 'queued', labels: ['boxlite'], runner: null }])
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
