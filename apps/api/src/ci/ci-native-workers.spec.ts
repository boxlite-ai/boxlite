/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '../../../libs/ci-listener/tests/capacity'
import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Header } from 'tar'
import { DataSource } from 'typeorm'
import { ConfirmedWorkerAbsent, decodeScope, ExecutionJournal, ExecutionLease, scopeKey } from '@boxlite-ai/ci-listener'
import { WorkerPool } from '../../../libs/ci-listener/src/execution/pool'
import { CiNativeState } from './ci-native-state'
import { CiNativeWorkers } from './ci-native-workers'
import { Box } from '../box/entities/box.entity'
import { BoxLastActivity } from '../box/entities/box-last-activity.entity'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxService } from '../box/services/box.service'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'

const database = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = database ? describe : describe.skip
integration('CI native workers (shared lease, actual PostgreSQL and HTTP)', () => {
  const schema = 'ci_native_' + randomUUID().replaceAll('-', ''),
    org = randomUUID(),
    binding = randomUUID(),
    runnerId = randomUUID()
  const app = 'test-app',
    actor = 'provider|owner',
    key = 'runner-test-key',
    jit = Buffer.from('private-native-jit').toString('base64')
  const scope = () =>
    decodeScope({
      binding,
      generation: 1,
      organization: org,
      actor,
      installation: { id: 10, account: { id: 20, login: 'owner', type: 'User' } },
      runners: {
        kind: 'repository',
        allowPublic: true,
        repository: { id: 30, name: 'repo', private: false, owner: { id: 20, login: 'owner' } },
      },
    })
  let db: DataSource,
    platform: BoxService,
    store: CiNativeState,
    workers: CiNativeWorkers,
    journal: ExecutionJournal,
    lease: ExecutionLease
  let server: Server, endpoint: string
  let received: { url: string; auth: string; file: string; content: string }[]
  let respond: () => Promise<number>
  const beforePersist = jest.fn(),
    organizations = { findOne: jest.fn() },
    limits = { resolveMaxCreatedBoxes: jest.fn() },
    runners = { findOneUncachedOrFail: jest.fn() }
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(database!).hostname))
      throw Error('Disposable local PostgreSQL required')
    db = await new DataSource({
      type: 'postgres',
      url: database,
      schema,
      entities: [Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    await db.query(`CREATE TABLE ci_installation_binding(id uuid PRIMARY KEY,generation bigint,github_host text,
      app_client_id text,installation_id bigint,account_id bigint,account_login text,account_type text,
      organization_id uuid,actor_id text,allow_public boolean,follow_installation boolean,state text);
      CREATE TABLE "user"(id text PRIMARY KEY,role text);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text);
      CREATE TABLE organization_activation_facts("organizationId" uuid PRIMARY KEY,"lastBoxCreatedAt" timestamptz,"lastBoxModifiedAt" timestamptz)`)
    const query = db.createQueryRunner()
    try {
      await new AddCiListenerState1793700000000().up(query)
    } finally {
      await query.release()
    }
    const repository = new BoxRepository(
      db,
      { emit: jest.fn() } as any,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any,
    )
    const args = Array.from({ length: 21 }, () => ({}))
    args[0] = repository
    args[7] = { emit: jest.fn() }
    args[8] = organizations
    platform = new (BoxService as any)(...args)
    // VM provisioning is external. Keep the production repository transaction
    // and onPersist hook, so denied admissions must actually roll back its Box.
    jest.spyOn(platform, 'create').mockImplementation(async (dto, organization, _ctx, options) => {
      await beforePersist()
      const box = new Box('test-region', dto.name)
      Object.assign(box, {
        organizationId: organization.id,
        runnerId,
        osUser: 'runner',
        labels: {},
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
      await repository.insert(box, options?.maxCreatedBoxes, options?.onPersist)
      return { ...box } as any
    })
    jest.spyOn(platform, 'toBoxDtoWithExitCode').mockImplementation(async (box) => ({ ...box }) as any)
    jest.spyOn(platform, 'stop').mockResolvedValue(undefined)
    jest.spyOn(platform, 'destroy').mockResolvedValue(undefined)
    store = new CiNativeState(db, { get: () => app } as any)
    workers = new CiNativeWorkers(store, platform, organizations as any, limits as any, runners as any)
    server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks),
          header = new Header(body)
        received.push({
          url: req.url!,
          auth: req.headers.authorization!,
          file: header.path!,
          content: body.subarray(512, 512 + header.size!).toString(),
        })
        const status = await respond()
        res.writeHead(status, { Location: endpoint + '/credential-trap' }).end(status === 204 ? undefined : key + jit)
      } catch {
        res.destroy()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (db?.isInitialized)
      try {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE ci_listener_state,ci_installation_binding,"user",organization_user,box,box_last_activity')
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com',$2,10,20,'owner','User',$3,$4,true,true,'ready')`,
      [binding, app, org, actor],
    )
    await db.query('INSERT INTO "user" VALUES($1,\'user\')', [actor])
    await db.query("INSERT INTO organization_user VALUES($1,$2,'owner')", [org, actor])
    beforePersist.mockReset().mockResolvedValue(undefined)
    organizations.findOne.mockReset().mockResolvedValue({ id: org })
    limits.resolveMaxCreatedBoxes.mockReset().mockResolvedValue(4)
    runners.findOneUncachedOrFail.mockReset().mockResolvedValue({ id: runnerId, apiUrl: endpoint, apiKey: key })
    jest.mocked(platform.stop).mockClear()
    jest.mocked(platform.destroy).mockClear()
    received = []
    respond = async () => 204
    await store.initialize()
    journal = new ExecutionJournal(store.state)
    lease = (await store.state.acquire(randomUUID(), 30000))!
  })
  async function prepared(job?: number) {
    await journal.define(lease, scope())
    const allocation = await journal.reserve(
      lease,
      scopeKey(scope()),
      { repository: 30, run: 40, job: job ?? 50 + (await db.getRepository(Box).count()) },
      testCapacity({ account: 4, tenant: 4 }),
    )
    if (!allocation) throw Error('Expected reserved allocation')
    const row = await journal.advance(lease, allocation.record.key, allocation.record.version, {
      box: { phase: 'requested', id: null },
      effect: { id: randomUUID(), kind: 'box-create' },
    })
    const config = { name: row.value.name, image: 'runner:test', cpus: 2, memoryMiB: 2048, entrypoint: ['/runner'] }
    return { row, config, host: workers.open(scope(), lease) }
  }
  async function created() {
    const value = await prepared(),
      box = await value.host.create(value.config)
    value.row = await journal.advance(lease, value.row.record.key, value.row.record.version, {
      box: { phase: 'known', id: box.box_id },
    })
    return { ...value, box }
  }
  async function forDelivery() {
    const value = await created()
    value.row = await journal.advance(lease, value.row.record.key, value.row.record.version, {
      runner: { phase: 'requested', id: null },
      effect: { id: randomUUID(), kind: 'runner-register' },
    })
    value.row = await journal.advance(lease, value.row.record.key, value.row.record.version, {
      runner: { phase: 'known', id: 7 },
    })
    value.row = await journal.advance(lease, value.row.record.key, value.row.record.version, {
      delivery: 'requested',
      effect: { id: randomUUID(), kind: 'jit-deliver' },
    })
    return value
  }
  async function deleting() {
    const value = await created()
    await db.getRepository(Box).update(value.box.box_id, {
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
    })
    value.row = await journal.advance(lease, value.row.record.key, value.row.record.version, {
      closing: true,
      effect: { id: randomUUID(), kind: 'box-remove' },
    })
    jest.mocked(platform.destroy).mockImplementationOnce(BoxService.prototype.destroy.bind(platform))
    await value.host.remove(value.config.name)
    return value
  }
  it('commits the real original Box ID with the Box row in the single shared table', async () => {
    const { host, config, box } = await created()
    const [ledger] = await store.state.read(['box-native/' + config.name.slice(7)])
    expect(ledger.payload).toEqual({ scope: scopeKey(scope()), box: box.box_id })
    expect(await host.get(config.name)).toMatchObject({ box_id: box.box_id, status: 'running' })
    expect(await db.getRepository(Box).count()).toBe(1)
    expect(limits.resolveMaxCreatedBoxes).toHaveBeenCalledWith(org)
    await expect(host.create(config)).rejects.toThrow('already attempted')
  })
  it('creation refusal regression: a real quota race persists a recoverable no-creation fact', async () => {
    limits.resolveMaxCreatedBoxes.mockResolvedValue(1)
    const { host, config, row } = await prepared()
    beforePersist.mockImplementationOnce(async () => {
      const ordinary = new Box('test-region', 'ordinary-box')
      Object.assign(ordinary, {
        organizationId: org,
        osUser: 'runner',
        labels: {},
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STOPPED,
      })
      await db.getRepository(Box).save(ordinary)
    })
    const failure = await host.create(config).catch((error) => error)
    expect(failure.driverError?.message).toBeUndefined()
    expect(failure.constructor.name).toBe('ConfirmedWorkerCreationRejected')
    expect(failure.rejectedCreationEffect).toBe(row.value.effect!.id)
    expect(await db.getRepository(Box).count()).toBe(1)
    const [ledger] = await store.state.read(['box-native/' + config.name.slice(7)])
    expect(ledger.payload).toEqual({
      scope: scopeKey(scope()),
      box: null,
      rejectedCreationEffect: row.value.effect!.id,
    })
    const previousEpoch = lease.epoch
    await db.query(
      "UPDATE ci_listener_state SET payload=payload||'{\"until\":0}'::jsonb WHERE namespace=$1 AND record_key='@owner'",
      [store.namespace],
    )
    lease = (await store.state.acquire(randomUUID(), 30000))!
    expect(lease.epoch).toBe(previousEpoch + 1)
    const restarted = new CiNativeWorkers(store, platform, organizations as any, limits as any, runners as any).open(
      scope(),
      lease,
    )
    await expect(restarted.get(config.name)).rejects.toMatchObject({ rejectedCreationEffect: row.value.effect!.id })
    await expect(restarted.create(config)).rejects.toThrow('already attempted')
    expect(await db.getRepository(Box).count()).toBe(1)
  })
  it('creation refusal boundary: quota-like errors after entering persistence never become no-creation proofs', async () => {
    const { host, config, row } = await prepared()
    const create = jest.mocked(platform.create).getMockImplementation()!
    jest.mocked(platform.create).mockImplementationOnce((dto, org, ctx, options) =>
      create(dto, org, ctx, {
        ...options,
        onPersist: async (tx, box) => {
          await options!.onPersist!(tx, box)
          throw new BoxCreationLimitExceededError(1, 1)
        },
      }),
    )
    const failure = await host.create(config).catch((error) => error)
    expect(failure).toBeInstanceOf(BoxCreationLimitExceededError)
    expect(failure.rejectedCreationEffect).toBeUndefined()
    expect(await store.state.read(['box-native/' + config.name.slice(7)])).toEqual([])
    expect((await journal.load(lease)).allocations.get(row.record.key)!.value.box.phase).toBe('requested')
    expect((await journal.load(lease)).workers).toHaveLength(1)
  })
  it('creation refusal boundary: a typed error after committed persistence retains its original Box ID', async () => {
    const { host, config } = await prepared()
    const create = jest.mocked(platform.create).getMockImplementation()!
    jest.mocked(platform.create).mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new BoxCreationLimitExceededError(1, 1)
    })
    const failure = await host.create(config).catch((error) => error)
    expect(failure.rejectedCreationEffect).toBeUndefined()
    const [ledger] = await store.state.read(['box-native/' + config.name.slice(7)])
    expect(typeof (ledger.payload as any).box).toBe('string')
    expect(await host.get(config.name)).toMatchObject({ box_id: (ledger.payload as any).box })
    expect((await journal.load(lease)).workers).toHaveLength(1)
  })
  it('creation refusal boundary: a stale rejection ledger does not grant cleanup', async () => {
    const { host, config } = await prepared()
    await store.state.commit(lease, [
      {
        key: 'box-native/' + config.name.slice(7),
        expected: null,
        payload: { scope: scopeKey(scope()), box: null, rejectedCreationEffect: randomUUID() },
      },
    ])
    await expect(host.get(config.name)).rejects.toThrow('rejection operation changed')
    expect((await journal.load(lease)).workers).toHaveLength(1)
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it('creation refusal boundary: a known Box cannot also carry a rejection fact', async () => {
    const { host, config, box } = await created()
    const [record] = await store.state.read(['box-native/' + config.name.slice(7)])
    await store.state.commit(lease, [
      {
        key: record.key,
        expected: record.version,
        payload: { scope: scopeKey(scope()), box: box.box_id, rejectedCreationEffect: randomUUID() },
      },
    ])
    await expect(host.get(config.name)).rejects.toThrow('ledger changed')
    expect(await db.getRepository(Box).count()).toBe(1)
    expect((await journal.load(lease)).workers).toHaveLength(1)
  })
  it('creation refusal boundary: failed proof persistence preserves the unknown reservation', async () => {
    limits.resolveMaxCreatedBoxes.mockResolvedValue(0)
    const { host, config } = await prepared()
    const transaction = store.transaction.bind(store)
    let calls = 0
    const gate = jest.spyOn(store, 'transaction').mockImplementation(async (work) => {
      if (++calls === 2) throw Error('Refusal proof unavailable')
      return transaction(work)
    })
    try {
      await expect(host.create(config)).rejects.toThrow('Refusal proof unavailable')
    } finally {
      gate.mockRestore()
    }
    expect(await store.state.read(['box-native/' + config.name.slice(7)])).toEqual([])
    expect((await journal.load(lease)).workers).toHaveLength(1)
    await expect(host.get(config.name)).rejects.toThrow('ID is not durably known')
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it('creation refusal boundary: recording a rejected original operation survives owner revocation without granting new execution', async () => {
    limits.resolveMaxCreatedBoxes.mockResolvedValue(0)
    const { host, config, row } = await prepared()
    beforePersist.mockImplementationOnce(async () => {
      await db.query('DELETE FROM organization_user')
    })
    await expect(host.create(config)).rejects.toMatchObject({ rejectedCreationEffect: row.value.effect!.id })
    await expect(host.get(config.name)).rejects.toMatchObject({ rejectedCreationEffect: row.value.effect!.id })
    await expect(host.create(config)).rejects.toThrow('owner')
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it.each([
    ['binding', "UPDATE ci_installation_binding SET state='disabled'"],
    ['generation', 'UPDATE ci_installation_binding SET generation=2'],
    ['actor', "UPDATE ci_installation_binding SET actor_id='another'"],
    ['app', "UPDATE ci_installation_binding SET app_client_id='another'"],
    ['account', 'UPDATE ci_installation_binding SET account_id=21'],
    ['policy', 'UPDATE ci_installation_binding SET allow_public=false'],
    ['owner', 'DELETE FROM organization_user'],
  ])('rolls back the actual Box when %s changes before persistence', async (_kind, sql) => {
    const { host, config } = await prepared()
    beforePersist.mockImplementationOnce(() => db.query(sql))
    await expect(host.create(config)).rejects.toThrow()
    expect(await db.getRepository(Box).count()).toBe(0)
    expect(await store.state.read(['box-native/' + config.name.slice(7)])).toHaveLength(0)
    expect((await journal.load(lease)).allocations.size).toBe(1)
  })
  it('rechecks the execution epoch inside Box persistence after a real lease takeover', async () => {
    // Short lease deliberately expires during provisioning, before onPersist.
    await db.query(
      `UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'::jsonb) WHERE record_key='@owner'`,
    )
    lease = (await store.state.acquire(randomUUID(), 300))!
    const { host, config } = await prepared()
    let replacement: ExecutionLease | undefined
    beforePersist.mockImplementationOnce(async () => {
      await delay(350)
      replacement = await store.state.acquire(randomUUID(), 30000)
    })
    await expect(host.create(config)).rejects.toThrow('lease')
    expect(replacement).toBeDefined()
    expect(replacement!.epoch).toBe(lease.epoch + 1)
    expect(await db.getRepository(Box).count()).toBe(0)
    expect(await store.state.read(['box-native/' + config.name.slice(7)])).toHaveLength(0)
    expect((await journal.load(replacement!)).allocations.size).toBe(1)
  })
  it('rejects a changed platform organization at the real persistence boundary', async () => {
    const { host, config } = await prepared()
    organizations.findOne.mockResolvedValueOnce({ id: randomUUID() })
    await expect(host.create(config)).rejects.toThrow('persistence intent')
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it('preserves Commerce failure instead of admitting an unmetered Box', async () => {
    const { host, config } = await prepared()
    limits.resolveMaxCreatedBoxes.mockRejectedValueOnce(Error('Commerce unavailable'))
    await expect(host.create(config)).rejects.toThrow('Commerce unavailable')
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it('allows current admin authority without membership but denies a missing actor', async () => {
    const { host, config } = await prepared()
    await db.query('DELETE FROM organization_user')
    await expect(host.create(config)).rejects.toThrow('owner')
    await db.query('UPDATE "user" SET role=\'admin\'')
    const box = await host.create(config)
    expect(box.box_id).toBeTruthy()
    await db.query('DELETE FROM "user"')
    const next = await prepared()
    await expect(next.host.create(next.config)).rejects.toThrow('actor')
  })
  it('keeps original-resource cleanup after binding removal without admitting a new Box', async () => {
    const { host, config, row, box } = await created()
    await db.query('DELETE FROM ci_installation_binding; DELETE FROM "user"; DELETE FROM organization_user')
    await journal.advance(lease, row.record.key, row.record.version, {
      closing: true,
      effect: { id: randomUUID(), kind: 'box-stop' },
    })
    await host.stop(config.name)
    expect(platform.stop).toHaveBeenCalledWith(box.box_id, org, expect.anything(), true, 'id')
    expect(await host.get(config.name)).toMatchObject({ box_id: box.box_id })
    const next = await prepared()
    await expect(next.host.create(next.config)).rejects.toThrow('binding')
  })
  it('rejects a conflicting ID ledger before the actual stop capability', async () => {
    const { host, config, row } = await created(),
      key = 'box-native/' + config.name.slice(7)
    const [ledger] = await store.state.read([key])
    await store.state.commit(lease, [
      { key, expected: ledger.version, payload: { scope: scopeKey(scope()), box: 'foreign-box' } },
    ])
    await journal.advance(lease, row.record.key, row.record.version, {
      closing: true,
      effect: { id: randomUUID(), kind: 'box-stop' },
    })
    await expect(host.stop(config.name)).rejects.toThrow('ledger changed')
    expect(platform.stop).not.toHaveBeenCalled()
  })
  it('distinguishes an unknown original ID from a confirmed absent known Box', async () => {
    const unknown = await prepared()
    await expect(unknown.host.get(unknown.config.name)).rejects.not.toBeInstanceOf(ConfirmedWorkerAbsent)
    const box = await unknown.host.create(unknown.config)
    await journal.advance(lease, unknown.row.record.key, unknown.row.record.version, {
      box: { phase: 'known', id: box.box_id },
    })
    await db.getRepository(Box).delete(box.box_id)
    await expect(unknown.host.get(unknown.config.name)).rejects.toBeInstanceOf(ConfirmedWorkerAbsent)
  })
  it('recognizes the original destroyed Box after production soft deletion renames it', async () => {
    const { host, config, box } = await deleting()
    const deleted = await platform.findOne(box.box_id, true)
    expect(deleted.name).toMatch(new RegExp('^DESTROYED_' + config.name + '_[0-9]+$'))
    expect(deleted).toMatchObject({ desiredState: BoxDesiredState.DESTROYED, pending: true })
    await expect(host.get(config.name)).rejects.not.toBeInstanceOf(ConfirmedWorkerAbsent)
    // Only the runtime's terminal confirmation proves physical absence.
    await db.getRepository(Box).update(box.box_id, { state: BoxState.DESTROYED, pending: false })
    await expect(host.get(config.name)).rejects.toBeInstanceOf(ConfirmedWorkerAbsent)
  })
  it('releases a renamed terminal worker before reserving the next job at capacity one', async () => {
    const { host, row, box } = await deleting()
    const capacity = testCapacity({ account: 1, tenant: 1 })
    const nextJob = { repository: 30, run: 41, job: 60 }
    await expect(journal.reserve(lease, scopeKey(scope()), nextJob, capacity)).resolves.toBeUndefined()
    await db.getRepository(Box).update(box.box_id, { state: BoxState.DESTROYED, pending: false })
    const pool = new WorkerPool(
      journal,
      scopeKey(scope()),
      async () => ({ workers: host, admit: jest.fn(), job: jest.fn(), runners: jest.fn() }),
      { image: 'runner:test', cpus: 2, memoryMiB: 2048, labels: ['boxlite-ci-runner'] },
    )
    try {
      await pool.tick(lease, capacity)
      expect((await journal.load(lease)).allocations.has(row.record.key)).toBe(false)
      const next = await journal.reserve(lease, scopeKey(scope()), nextJob, capacity)
      expect(next?.value.job).toEqual(nextJob)
      expect(next?.record.key).not.toBe(row.record.key)
    } finally {
      await pool.close()
    }
  })
  it('rejects a foreign organization even when the renamed original Box is destroyed', async () => {
    const { host, config, box } = await deleting()
    await db.getRepository(Box).update(box.box_id, {
      organizationId: randomUUID(),
      state: BoxState.DESTROYED,
      pending: false,
    })
    await expect(host.get(config.name)).rejects.toThrow('ownership changed')
    await expect(host.remove(config.name)).rejects.toThrow('ownership changed')
    expect(platform.destroy).toHaveBeenCalledTimes(1)
  })
  it('rejects a renamed live Box without interpreting its name as terminal absence', async () => {
    const { host, config, box } = await created()
    await db.getRepository(Box).update(box.box_id, { name: 'DESTROYED_' + config.name + '_123' })
    await expect(host.get(config.name)).rejects.toThrow('ownership changed')
    expect(platform.destroy).not.toHaveBeenCalled()
  })
  it('requires the current journaled effect before stop or deletion', async () => {
    const { host, config } = await created()
    await expect(host.stop(config.name)).rejects.toThrow('effect intent')
    await expect(host.remove(config.name)).rejects.toThrow('effect intent')
    expect(platform.stop).not.toHaveBeenCalled()
    expect(platform.destroy).not.toHaveBeenCalled()
  })
  it('delivers private JIT content then ready through HTTP and never persists its secret', async () => {
    const { host, config, box } = await forDelivery()
    await host.deliverJit(config.name, jit)
    expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig', '.boxlite-jitconfig.ready'])
    expect(received.map((r) => r.content)).toEqual([jit, 'ready'])
    expect(
      received.every(
        (r) => r.url === `/v1/boxes/${box.box_id}/files?path=%2Fhome%2Frunner` && r.auth === `Bearer ${key}`,
      ),
    ).toBe(true)
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('already attempted')
    const rows = JSON.stringify(await db.query('SELECT payload FROM ci_listener_state'))
    expect(rows).not.toContain(jit)
    expect(rows).not.toContain(key)
    expect(received).toHaveLength(2)
  })
  it('keeps an uncertain JIT attempt and never sends ready after an HTTP failure', async () => {
    const { host, config } = await forDelivery()
    respond = async () => 503
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('delivery failed')
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('already attempted')
    expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig'])
  })
  it('rechecks binding revocation between content and the ready HTTP request', async () => {
    const { host, config } = await forDelivery()
    respond = async () => {
      await db.query("UPDATE ci_installation_binding SET state='disabled'")
      return 204
    }
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('binding')
    expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig'])
  })
  it('enforces the actual Box repository quota across concurrent shared allocations', async () => {
    limits.resolveMaxCreatedBoxes.mockResolvedValue(1)
    const first = await prepared(51),
      second = await prepared(52)
    const outcomes = await Promise.allSettled([first.host.create(first.config), second.host.create(second.config)])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(await db.getRepository(Box).count()).toBe(1)
  })
  it('accepts the maximum JIT size at the actual HTTP boundary', async () => {
    const { host, config } = await forDelivery(),
      maximum = 'A'.repeat(1048576)
    await host.deliverJit(config.name, maximum)
    expect(received.map((r) => r.content)).toEqual([maximum, 'ready'])
  })
  it('allows only one concurrent JIT publisher through the shared record claim', async () => {
    const { host, config } = await forDelivery(),
      other = workers.open(scope(), lease)
    const outcomes = await Promise.allSettled([host.deliverJit(config.name, jit), other.deliverJit(config.name, jit)])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig', '.boxlite-jitconfig.ready'])
  })
  it.each(['', 'not-base64!', 'A'.repeat(1048580)])(
    'rejects invalid JIT without claiming or uploading',
    async (input) => {
      const { host, config } = await forDelivery()
      await expect(host.deliverJit(config.name, input)).rejects.toThrow('base64')
      const [ledger] = await store.state.read(['box-native/' + config.name.slice(7)])
      expect(ledger.payload).not.toHaveProperty('delivery')
      expect(received).toHaveLength(0)
    },
  )
  it.each(['owner', 'binding', 'generation', 'org', 'stopped', 'pending', 'desired', 'foreign-name'])(
    'denies %s before any JIT request',
    async (change) => {
      const { host, config, box } = await forDelivery()
      if (change === 'owner') await db.query('DELETE FROM organization_user')
      if (change === 'binding') await db.query("UPDATE ci_installation_binding SET state='disabled'")
      if (change === 'generation') await db.query('UPDATE ci_installation_binding SET generation=2')
      if (change === 'org') await db.getRepository(Box).update(box.box_id, { organizationId: randomUUID() })
      if (change === 'stopped') await db.getRepository(Box).update(box.box_id, { state: BoxState.STOPPED })
      if (change === 'pending') await db.getRepository(Box).update(box.box_id, { pending: true })
      if (change === 'desired')
        await db.getRepository(Box).update(box.box_id, { desiredState: BoxDesiredState.STOPPED })
      await expect(
        host.deliverJit(change === 'foreign-name' ? 'ci-jit-' + randomUUID().replaceAll('-', '') : config.name, jit),
      ).rejects.toThrow()
      expect(received).toHaveLength(0)
    },
  )
  it.each(['owner', 'binding', 'runner', 'org', 'stopped'])(
    'does not publish ready after %s changes',
    async (change) => {
      const { host, config, box } = await forDelivery()
      respond = async () => {
        if (change === 'owner') await db.query('DELETE FROM organization_user')
        if (change === 'binding') await db.query('DELETE FROM ci_installation_binding')
        if (change === 'runner') await db.getRepository(Box).update(box.box_id, { runnerId: randomUUID() })
        if (change === 'org') await db.getRepository(Box).update(box.box_id, { organizationId: randomUUID() })
        if (change === 'stopped') await db.getRepository(Box).update(box.box_id, { state: BoxState.STOPPED })
        return 204
      }
      await expect(host.deliverJit(config.name, jit)).rejects.toThrow()
      expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig'])
    },
  )
  it.each([200, 302, 401, 404, 500])(
    'preserves a failed delivery on HTTP %i without following redirects',
    async (status) => {
      const { host, config } = await forDelivery()
      respond = async () => status
      await expect(host.deliverJit(config.name, jit)).rejects.toThrow('original Box requires reconciliation')
      await expect(workers.open(scope(), lease).deliverJit(config.name, jit)).rejects.toThrow('already attempted')
      expect(received).toHaveLength(1)
    },
  )
  it('rejects an already cancelled JIT request without a delivery claim', async () => {
    const { host, config } = await forDelivery(),
      cancel = new AbortController()
    cancel.abort()
    await expect(host.deliverJit(config.name, jit, cancel.signal)).rejects.toThrow()
    const [ledger] = await store.state.read(['box-native/' + config.name.slice(7)])
    expect(ledger.payload).not.toHaveProperty('delivery')
    expect(received).toHaveLength(0)
  })
  it('retains an in-flight cancelled JIT claim without replay', async () => {
    const { host, config } = await forDelivery(),
      cancel = new AbortController()
    respond = async () => {
      cancel.abort()
      return 204
    }
    await expect(host.deliverJit(config.name, jit, cancel.signal)).rejects.toThrow()
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('already attempted')
    expect(received).toHaveLength(1)
  })
  it('times out an unacknowledged JIT upload without ready or replay', async () => {
    const { host, config } = await forDelivery(),
      timeout = AbortSignal.timeout.bind(AbortSignal)
    const deadline = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1000))
    let release!: () => void
    respond = () =>
      new Promise<number>((resolve) => {
        release = () => resolve(204)
      })
    try {
      await expect(host.deliverJit(config.name, jit)).rejects.toThrow('delivery failed')
    } finally {
      deadline.mockRestore()
      release?.()
    }
    expect(received).toHaveLength(1)
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('already attempted')
  })
  it('rejects a closing allocation before Box persistence', async () => {
    const { host, config, row } = await prepared()
    await journal.advance(lease, row.record.key, row.record.version, { closing: true })
    await expect(host.create(config)).rejects.toThrow('closing')
    expect(await db.getRepository(Box).count()).toBe(0)
  })
  it('rejects a closing allocation before JIT HTTP delivery', async () => {
    const { host, config, row } = await forDelivery()
    await journal.advance(lease, row.record.key, row.record.version, { closing: true })
    let failure: unknown
    try {
      await host.deliverJit(config.name, jit)
    } catch (error) {
      failure = error
    }
    expect(received).toHaveLength(0)
    expect(failure).toBeDefined()
  })
  it.each(['binding', 'lease'])('rechecks late %s loss after the Box lookup before JIT HTTP', async (kind) => {
    const { host, config } = await forDelivery(),
      findOne = platform.findOne.bind(platform)
    let reads = 0
    const lookup = jest.spyOn(platform, 'findOne').mockImplementation(async (...args) => {
      const box = await findOne(...args)
      if (++reads === 2) {
        if (kind === 'binding') await db.query("UPDATE ci_installation_binding SET state='disabled'")
        else {
          await db.query(
            `UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'::jsonb) WHERE record_key='@owner'`,
          )
          expect(await store.state.acquire(randomUUID(), 30000)).toBeDefined()
        }
      }
      return box
    })
    try {
      let failure: unknown
      try {
        await host.deliverJit(config.name, jit)
      } catch (error) {
        failure = error
      }
      expect(received).toHaveLength(0)
      expect(failure).toBeDefined()
    } finally {
      lookup.mockRestore()
    }
  })
  it('rechecks a stolen execution lease before the ready HTTP request', async () => {
    const { host, config } = await forDelivery()
    respond = async () => {
      await db.query(
        `UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'::jsonb) WHERE record_key='@owner'`,
      )
      expect(await store.state.acquire(randomUUID(), 30000)).toBeDefined()
      return 204
    }
    await expect(host.deliverJit(config.name, jit)).rejects.toThrow('lease')
    expect(received.map((r) => r.file)).toEqual(['.boxlite-jitconfig'])
  })
})
