/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '@boxlite-ai/ci-listener/testing'
import { testCapacity } from '@boxlite-ai/ci-listener/testing'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Header } from 'tar'
import {
  ConfirmedWorkerAbsent,
  ExecutionJournal,
  ExecutionLease,
  ExecutionScope,
  ListenerState,
  WorkerExecutor,
} from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '@boxlite-ai/ci-listener/sqlite'
import { BoxLiteWorkers } from './boxlite-workers'
import { BoxLiteRequestError } from './boxlite-http'

describe('Standalone BoxLite execution boundary', () => {
  const originalFetch = global.fetch
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    journal: ExecutionJournal,
    lease: ExecutionLease,
    service: BoxLiteWorkers,
    worker: WorkerExecutor,
    scope: ExecutionScope,
    namespace: string,
    key: string,
    name: string,
    box: { box_id: string; name: string; status: string } | undefined,
    principal: { sub: string; principal_type: string; path_prefix: string },
    loseCreate: boolean,
    loseStart: boolean,
    notFound: boolean,
    listDenied: boolean,
    listOriginal: boolean,
    uploadFailed: boolean,
    allowed: boolean,
    initialStatus: string,
    afterUpload: (() => void) | undefined,
    afterList: (() => void) | undefined,
    calls: { path: string; method: string; body: unknown }[]
  let meGate: { entered(): void; wait: Promise<void> } | undefined
  let createHttpStatus: number | undefined
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-self-rest-'))
    db = new SqliteStateDatabase(directory)
    namespace = 'ci:' + randomUUID()
    state = new ListenerState(db, namespace)
    journal = new ExecutionJournal(state)
    principal = { sub: 'owner-a', principal_type: 'service_account', path_prefix: 'tenant-a' }
    loseCreate = loseStart = notFound = listDenied = listOriginal = uploadFailed = false
    allowed = true
    initialStatus = 'running'
    createHttpStatus = undefined
    meGate = undefined
    afterUpload = afterList = undefined
    box = undefined
    calls = []
    global.fetch = jest.fn(async (input, options) => {
      const path = new URL(String(input)).pathname,
        method = options?.method ?? 'GET',
        body = typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body
      calls.push({ path, method, body })
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (path === '/v1/me') {
        meGate?.entered()
        if (meGate) await meGate.wait
        return json(principal)
      }
      if (path === '/v1/tenant-a/boxes' && method === 'POST') {
        const input = body as { name: string }
        box = { box_id: 'original-box', name: input.name, status: initialStatus }
        if (loseCreate) throw new Error('Lost create response')
        if (createHttpStatus) return json({}, createHttpStatus)
        return json(box, 201)
      }
      if (path === '/v1/tenant-a/boxes' && method === 'GET') {
        if (listDenied) return json({}, 403)
        const result = json({ boxes: listOriginal && box ? [box] : [] })
        afterList?.()
        return result
      }
      if (path === '/v1/tenant-a/boxes/original-box' && method === 'GET')
        return box && !notFound ? json(box) : json({}, 404)
      if (path === '/v1/tenant-a/boxes/original-box/start') {
        expect((await state.read(['box-rest/' + name]))[0]).toBeDefined()
        box!.status = 'running'
        if (loseStart) throw new Error('Lost start response')
        return json(box)
      }
      if (path === '/v1/tenant-a/boxes/original-box/stop') {
        box!.status = 'stopped'
        return new Response(null, { status: 204 })
      }
      if (path === '/v1/tenant-a/boxes/original-box' && method === 'DELETE') {
        box = undefined
        return new Response(null, { status: 204 })
      }
      if (path === '/v1/tenant-a/boxes/original-box/files') {
        if (uploadFailed) return json({}, 503)
        afterUpload?.()
        return new Response(null, { status: 204 })
      }
      throw new Error('Unexpected test API request')
    }) as typeof fetch
    service = await BoxLiteWorkers.connect(state, 'https://box.test', 'private-box-api-key')
    lease = (await state.acquire('test-owner', 300000))!
    scope = {
      binding: 'binding',
      generation: 1,
      organization: 'tenant-a',
      actor: 'owner-a',
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
      runners: {
        kind: 'repository',
        repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
        allowPublic: false,
      },
    }
    key = await journal.define(lease, scope)
    const row = (await journal.reserve(
      lease,
      key,
      { repository: 21, run: 33, job: 55 },
      testCapacity({ account: 1, tenant: 1 }),
    ))!
    name = row.value.name
    worker = service.bind(scope, lease, async () => {
      if (!allowed) throw new Error('Admission revoked')
    })
  })
  afterEach(async () => {
    global.fetch = originalFetch
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const launch = () => ({ name, image: 'runner-test', cpus: 2, memoryMiB: 2048, entrypoint: ['bash', '-c', 'run'] })
  const advance = async (change: Parameters<ExecutionJournal['advance']>[3]) => {
    const row = [...(await inspectJournal(state, lease)).allocations.values()][0]
    return journal.advance(lease, row.record.key, row.record.version, change)
  }
  const create = async () => {
    await advance({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
    const result = await worker.create(launch())
    await advance({ box: { phase: 'known', id: result.box_id } })
    return result
  }
  const prepareDelivery = async () => {
    await create()
    await advance({ runner: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'runner-register' } })
    await advance({ runner: { phase: 'known', id: 91 } })
    await advance({ delivery: 'requested', effect: { id: randomUUID(), kind: 'jit-deliver' } })
  }
  const posts = () => calls.filter((call) => call.path === '/v1/tenant-a/boxes' && call.method === 'POST')
  it('requires the durable intent and records a positive original ID before boot', async () => {
    await expect(worker.create(launch())).rejects.toThrow('intent missing')
    expect(posts()).toHaveLength(0)
    initialStatus = 'configured'
    expect(await create()).toMatchObject({ box_id: 'original-box', status: 'running' })
    expect(posts()[0].body).toMatchObject({
      name,
      user: 'runner',
      working_dir: '/home/runner',
      memory_mib: 2048,
      auto_stop: 0,
      auto_resume: false,
    })
    const [ledger] = await state.read(['box-rest/' + name])
    expect(ledger.payload).toMatchObject({ box: 'original-box', name, scope: key })
    expect(JSON.stringify(await state.recover(lease))).not.toContain('private-box-api-key')
  })
  it('recovers a known original ID after the start response is lost without repeating create', async () => {
    initialStatus = 'configured'
    loseStart = true
    await advance({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
    await expect(worker.create(launch())).rejects.toThrow('request failed')
    expect(await worker.get(name)).toMatchObject({ box_id: 'original-box', status: 'running' })
    expect(posts()).toHaveLength(1)
  })
  it('does not adopt a same-name Box after an unknown create response', async () => {
    loseCreate = true
    await advance({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
    await expect(worker.create(launch())).rejects.toThrow()
    await expect(worker.get(name)).rejects.toThrow('not durably known')
    expect(box?.name).toBe(name)
    expect(posts()).toHaveLength(1)
    expect(calls.filter((call) => call.path.startsWith('/v1/tenant-a/boxes/') && call.method === 'GET')).toEqual([])
  })
  it.each([0, 137, null])('recovery regression: preserves the observed exit code %s', async (exit_code) => {
    await create()
    Object.assign(box!, { status: 'stopped', exit_code })
    expect(await worker.get(name)).toMatchObject({ box_id: 'original-box', status: 'stopped', exit_code })
  })
  it.each(['0', 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid observed exit code %s', async (exit_code) => {
    await create()
    Object.assign(box!, { status: 'stopped', exit_code })
    await expect(worker.get(name)).rejects.toThrow('Invalid original CI Box exit code')
  })
  it('rejects another platform organization or actor before using the API', () => {
    expect(() => service.bind({ ...scope, organization: 'another' }, lease, async () => {})).toThrow('does not match')
    expect(() => service.bind({ ...scope, actor: 'another' }, lease, async () => {})).toThrow('does not match')
  })
  it('does not send a create after admission is revoked', async () => {
    allowed = false
    await expect(worker.create(launch())).rejects.toThrow('revoked')
    expect(posts()).toHaveLength(0)
  })
  it('checks the lease after an asynchronous principal request before mutation', async () => {
    await advance({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
      }),
      wait = new Promise<void>((resolve) => {
        resume = resolve
      })
    meGate = { entered, wait }
    const pending = worker.create(launch())
    await started
    await db.transaction(namespace, async (tx) => {
      const row = (await tx.get('@owner', true))!,
        payload = row.payload as { epoch: number }
      await tx.put(
        { ...row, version: randomUUID(), payload: { ...(row.payload as object), epoch: payload.epoch + 1 } },
        row.version,
      )
    })
    resume()
    await expect(pending).rejects.toThrow('lease')
    expect(posts()).toHaveLength(0)
  })
  it.each(['still-listed', 'list-denied', 'principal-changed'])(
    'does not treat one 404 as absence: %s',
    async (kind) => {
      await create()
      notFound = true
      if (kind === 'still-listed') listOriginal = true
      if (kind === 'list-denied') listDenied = true
      if (kind === 'principal-changed')
        afterList = () => {
          principal.sub = 'different'
        }
      await expect(worker.get(name)).rejects.not.toBeInstanceOf(ConfirmedWorkerAbsent)
    },
  )
  it('confirms absence through the original principal and a complete inventory', async () => {
    await create()
    notFound = true
    await expect(worker.get(name)).rejects.toBeInstanceOf(ConfirmedWorkerAbsent)
    expect(calls.some((call) => call.path === '/v1/tenant-a/boxes' && call.method === 'GET')).toBe(true)
  })
  it('rejects a renamed/replaced resource rather than using its returned identity', async () => {
    await create()
    box!.box_id = 'replacement'
    await expect(worker.get(name)).rejects.toThrow('identity or state changed')
  })
  it('requires a stopped original Box and separate cleanup intents before deletion', async () => {
    await create()
    await expect(worker.remove(name)).rejects.toThrow('must stop')
    await advance({ closing: true, effect: { id: randomUUID(), kind: 'box-stop' } })
    await worker.stop(name)
    await advance({ effect: { id: randomUUID(), kind: 'box-remove' } })
    await worker.remove(name)
    await expect(worker.get(name)).rejects.toBeInstanceOf(ConfirmedWorkerAbsent)
  })
  it('uploads content then ready as fixed private archives without persisting the JIT', async () => {
    await prepareDelivery()
    await worker.deliverJit(name, 'c2VjcmV0')
    const uploads = calls.filter((call) => call.method === 'PUT'),
      headers = uploads.map((call) => new Header(Buffer.from(call.body as Uint8Array)))
    expect(headers.map((header) => header.path)).toEqual(['.boxlite-jitconfig', '.boxlite-jitconfig.ready'])
    expect(headers.every((header) => header.mode === 0o600)).toBe(true)
    expect(
      Buffer.from(uploads[0].body as Uint8Array)
        .subarray(512, 520)
        .toString(),
    ).toBe('c2VjcmV0')
    expect(JSON.stringify(await state.recover(lease))).not.toContain('c2VjcmV0')
  })
  it('never publishes ready after a failed content upload', async () => {
    await prepareDelivery()
    uploadFailed = true
    await expect(worker.deliverJit(name, 'c2VjcmV0')).rejects.toThrow('request failed')
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })
  it('rechecks admission before publishing ready', async () => {
    await prepareDelivery()
    afterUpload = () => {
      allowed = false
    }
    await expect(worker.deliverJit(name, 'c2VjcmV0')).rejects.toThrow('revoked')
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })
  it('keeps get read-only even when a known Box is configured', async () => {
    await create()
    box!.status = 'configured'
    const count = calls.filter((call) => call.method === 'POST').length
    expect((await worker.get(name)).status).toBe('starting')
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(count)
  })
  it('blocks mutation if the permanent backend identity record disappears', async () => {
    const [root] = await state.read(['backend/boxlite'])
    await state.commit(lease, [{ key: root.key, expected: root.version }])
    await expect(worker.create(launch())).rejects.toThrow('identity unavailable')
    expect(posts()).toHaveLength(0)
  })
  it('keeps an opaque provider subject intact through principal, scope and allocation', async () => {
    const actor = 'provider|Case-Sensitive-Account'
    principal.sub = actor
    const local = new ListenerState(db, 'opaque:' + randomUUID()),
      gateway = await BoxLiteWorkers.connect(local, 'https://box.test', 'private-box-api-key'),
      owner = (await local.acquire('opaque-owner', 300000))!,
      ledger = new ExecutionJournal(local),
      definition = { ...scope, actor }
    const target = await ledger.define(owner, definition),
      reserved = (await ledger.reserve(
        owner,
        target,
        { repository: 21, run: 33, job: 55 },
        testCapacity({ account: 1, tenant: 1 }),
      ))!
    await ledger.advance(owner, reserved.record.key, reserved.record.version, {
      box: { phase: 'requested', id: null },
      effect: { id: randomUUID(), kind: 'box-create' },
    })
    const result = await gateway
      .bind(definition, owner, async () => {})
      .create({ ...launch(), name: reserved.value.name })
    expect(result.box_id).toBe('original-box')
    expect(gateway.http.principal.sub).toBe(actor)
    expect((await ledger.scope(owner, target)).scope.actor).toBe(actor)
  })
  it('refuses a changed REST ledger ID at the actual stop boundary', async () => {
    await create()
    await advance({ closing: true, effect: { id: randomUUID(), kind: 'box-stop' } })
    const [ledger] = await state.read(['box-rest/' + name])
    await state.commit(lease, [
      { key: ledger.key, expected: ledger.version, payload: { ...(ledger.payload as object), box: 'foreign-box' } },
    ])
    const delegate = global.fetch
    let foreignStops = 0
    global.fetch = jest.fn(async (input, options) => {
      if (new URL(String(input)).pathname === '/v1/tenant-a/boxes/foreign-box/stop') {
        foreignStops++
        return new Response(null, { status: 204 })
      }
      return delegate(input, options)
    }) as typeof fetch
    let failure: unknown
    try {
      await worker.stop(name)
    } catch (error) {
      failure = error
    }
    expect(foreignStops).toBe(0)
    expect(failure).toBeDefined()
  })
  it('keeps an HTTP 408 mutation outcome uncertain when the server has created a Box', async () => {
    createHttpStatus = 408
    await advance({ box: { phase: 'requested', id: null }, effect: { id: randomUUID(), kind: 'box-create' } })
    let outcome: unknown
    try {
      await worker.create(launch())
    } catch (error) {
      outcome = error
    }
    expect(outcome).toBeInstanceOf(BoxLiteRequestError)
    expect(outcome).toMatchObject({ status: 408, uncertain: true })
    expect(box?.name).toBe(name)
    expect((await inspectJournal(state, lease)).allocations.size).toBe(1)
    await expect(worker.get(name)).rejects.toThrow('not durably known')
    expect(posts()).toHaveLength(1)
  })
})
