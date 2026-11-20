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

describe('CI shared execution authority', () => {
  const originalFetch = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    notice = { repository: 21, run: 33, job: 55 }
  let name: string,
    directory: string,
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
    const original = await journal.define(lease, scope)
    name = (await journal.reserve(lease, original, null, testCapacity({ account: 4, tenant: 4 }), {
      labels: ['boxlite'],
      scaleSet: 9,
    }))!.value.name
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
  it('rejects a late authorization after close without issuing a new credential or creating a Box', async () => {
    let enter!: () => void, resume!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      resume = resolve
    })
    jest.mocked(host.authorize).mockImplementationOnce(async () => {
      enter()
      await released
    })
    const creating = backend.workers.create(launch())
    const rejected = expect(creating).rejects.toThrow('backend is closed')
    try {
      await entered
      await backend.close()
      resume()
      await rejected
      expect(calls.some((call) => call.path.endsWith('/access_tokens'))).toBe(false)
      expect(host.workers.create).not.toHaveBeenCalled()
      await expect(backend.runners(async () => {}, undefined, ['boxlite'], name)).rejects.toThrow('backend is closed')
    } finally {
      resume()
      await creating.catch(() => {})
    }
  })
  it('rejects foreign worker names before issuing runner credentials', async () => {
    await expect(backend.runners(async () => {}, undefined, ['boxlite'], 'foreign')).rejects.toThrow(
      'credential isolation',
    )
    expect(calls.some((call) => call.path.endsWith('/access_tokens'))).toBe(false)
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
      const row = await journal.reserve(lease, key, null, testCapacity({ account: 2, tenant: 2 }), {
        labels: ['boxlite'],
        scaleSet: 9,
      })
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
  it('recovers the original JIT effect only while admission and repository access remain valid', async () => {
    expect(backend.workers.recoverJit).toBeUndefined()
    await backend.close()
    const recover = jest.fn(async () => 'delivered' as const)
    host.workers.recoverJit = recover
    backend = makeBackend()
    const effect = randomUUID()
    const signal = new AbortController().signal
    await expect(backend.workers.recoverJit!(name, effect, signal)).resolves.toBe('delivered')
    expect(host.authorize).toHaveBeenCalledWith(expect.anything(), 'admission', signal)
    expect(recover).toHaveBeenCalledWith(name, effect, signal)

    revoked = true
    await expect(backend.workers.recoverJit!(name, effect, signal)).rejects.toThrow('Admission revoked')
    revoked = false
    repository.private = false
    await expect(backend.workers.recoverJit!(name, effect, signal)).rejects.toThrow(
      'Original runner repository authority changed',
    )
    expect(recover).toHaveBeenCalledTimes(1)
  })
  it.each([null, {}, { token: 7 }])(
    'rejects a malformed registration response %j before exchanging it',
    async (result) => {
      const fetch = global.fetch
      const exchange = jest.fn()
      global.fetch = jest.fn(async (input, options) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/registration-token')) return new Response(JSON.stringify(result))
        if (path === '/actions/runner-registration') exchange()
        return fetch(input, options)
      })
      await expect(backend.scaleSets.currentStatistics(9, new AbortController().signal)).rejects.toThrow(
        'Invalid runner registration token',
      )
      expect(exchange).not.toHaveBeenCalled()
    },
  )
  it('rejects JIT delivery for a different reservation before sending the configuration', async () => {
    await expect(backend.workers.deliverJit('ci-jit-' + 'f'.repeat(32), 'c2VjcmV0')).rejects.toThrow(
      'Original scale set required',
    )
    expect(host.workers.deliverJit).not.toHaveBeenCalled()
  })
  it.each([undefined, 10])('refuses runner credentials for an unproven scale set %s', async (set) => {
    await expect(backend.runners(jest.fn(), undefined, ['boxlite'], name, set)).rejects.toThrow(
      'Original scale set required',
    )
    expect(calls).toHaveLength(0)
  })
  it.each(['unrecorded', 'different-runner', 'original'] as const)(
    'checks the recorded retirement when the runner is absent: %s',
    async (scenario) => {
      const owned = backend.scaleSets.registry(9, jest.fn())
      const lookup = jest.spyOn(owned, 'lookup').mockResolvedValue(null)
      jest.spyOn(backend.scaleSets, 'registry').mockReturnValue(owned)
      const journal = new ExecutionJournal(state)
      const key = 'worker/' + name.slice(7)
      const row = (await journal.allocation(lease, key))!
      if (scenario !== 'unrecorded') {
        const creating = await journal.advance(lease, key, row.record.version, {
          box: { phase: 'requested', id: null },
          effect: { kind: 'box-create', id: randomUUID() },
        })
        const registering = await journal.advance(lease, key, creating.record.version, {
          box: { phase: 'known', id: 'original-box' },
          runner: { phase: 'requested', id: null },
          effect: { kind: 'runner-register', id: randomUUID() },
        })
        await journal.advance(lease, key, registering.record.version, {
          runner: { phase: 'known', id: 91 },
          effect: { kind: 'runner-retire', id: randomUUID() },
        })
      }
      const guard = jest.fn()
      const credential = await backend.runners(guard, undefined, ['boxlite'], name, 9)
      const id = scenario === 'different-runner' ? 92 : 91
      await expect(credential.registry.retireIdle!({ id, name })).resolves.toBe(scenario === 'original')
      expect(lookup).toHaveBeenCalledWith({ id, name }, undefined)
      expect(guard).not.toHaveBeenCalled()
      await credential.close()
    },
  )
  it('checks scale-set membership after unregistering the original idle runner', async () => {
    const owned = backend.scaleSets.registry(9, jest.fn())
    const identity = { id: 91, name }
    const lookup = jest.spyOn(owned, 'lookup').mockResolvedValueOnce(identity).mockResolvedValueOnce(null)
    jest.spyOn(backend.scaleSets, 'registry').mockReturnValue(owned)
    const fetch = global.fetch
    global.fetch = jest.fn(async (input, options) =>
      new URL(String(input)).pathname.endsWith('/actions/runners/91') && (options?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ ...identity, status: 'online', busy: false }))
        : fetch(input, options),
    )
    const guard = jest.fn()
    const credential = await backend.runners(guard, undefined, ['boxlite'], name, 9)
    await expect(credential.registry.retireIdle!(identity)).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(guard).toHaveBeenCalledWith({ kind: 'remove', ...identity })
    expect(
      calls.filter(({ method }) => method === 'DELETE').some(({ path }) => path.endsWith('/actions/runners/91')),
    ).toBe(true)
    await credential.close()
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
  it('checks the execution epoch after the asynchronous host check before Box effects', async () => {
    takeover = true
    await expect(backend.workers.create(launch())).rejects.toBeInstanceOf(LeaseLost)
    expect(host.workers.create).not.toHaveBeenCalled()
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
