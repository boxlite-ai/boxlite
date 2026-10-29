/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { EncryptionService } from '../encryption/encryption.service'
import { TypedConfigService } from '../config/typed-config.service'
import { AddMcpOperations1793116800000 } from '../migrations/pre-deploy/1793116800000-add-mcp-operations-migration'
import { McpIdentity } from './mcp-authorization.service'
import { McpOperationStore } from './mcp-operation.store'
import { AddMcpGrants1793116800001 } from '../migrations/pre-deploy/1793116800001-add-mcp-grants-migration'
import { McpGrantStore } from './mcp-grant.store'

// Uses a disposable schema, never existing application tables.
const integration = process.env.MCP_TEST_DATABASE_URL ? describe : describe.skip
integration('McpOperationStore (Postgres)', () => {
  let database: DataSource
  let store: McpOperationStore
  const schema = `mcp_test_${randomUUID().replaceAll('-', '')}`
  const identity: McpIdentity = {
    userId: 'test-user',
    organizationId: randomUUID(),
    credential: { kind: 'api_key', keyHash: 'hash' },
  }
  const limits = { global: 10, runtimeSeconds: 60 }
  const encryption = new EncryptionService({ getOrThrow: (key: string) => key } as TypedConfigService)

  beforeAll(async () => {
    database = await new DataSource({
      type: 'postgres',
      url: process.env.MCP_TEST_DATABASE_URL,
      extra: { options: `-c search_path=${schema}` },
    }).initialize()
    await database.query(`CREATE SCHEMA ${schema}`)
    await database.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await database.query('INSERT INTO organization (id) VALUES ($1)', [identity.organizationId])
    const runner = database.createQueryRunner()
    try {
      await new AddMcpOperations1793116800000().up(runner)
      await new AddMcpGrants1793116800001().up(runner)
    } finally {
      await runner.release()
    }
    store = new McpOperationStore(database, encryption)
  })
  afterAll(async () => {
    if (database?.isInitialized) {
      await database.query(`DROP SCHEMA ${schema} CASCADE`)
      await database.destroy()
    }
  })
  beforeEach(async () => {
    await database.query('DELETE FROM mcp_operation')
    await database.query('DELETE FROM mcp_capacity_reservation')
  })

  const reserve = (requestId: string = randomUUID(), input = { command: 'echo', args: ['secret'] }) =>
    store.reserve(identity, 'exec_box', requestId, input, limits)

  it('encrypts payloads and deduplicates matching inputs without retaining a bearer', async () => {
    const operation = await reserve()
    expect(operation.payload).not.toContain('secret')
    expect(JSON.parse(await encryption.decrypt(operation.payload!))).toEqual({ command: 'echo', args: ['secret'] })
    expect((await reserve(operation.request_id)).id).toBe(operation.id)
    await expect(reserve(operation.request_id, { command: 'echo', args: ['changed'] })).rejects.toBeInstanceOf(
      ConflictException,
    )
  })
  it('canonicalizes nested keys while detecting changed nested values', async () => {
    const id = randomUUID()
    const first = await store.reserve(identity, 'create_box', id, { nested: { a: 1, b: 2 } }, limits)
    expect((await store.reserve(identity, 'create_box', id, { nested: { b: 2, a: 1 } }, limits)).id).toBe(first.id)
    await expect(store.reserve(identity, 'create_box', id, { nested: { a: 3, b: 2 } }, limits)).rejects.toBeInstanceOf(
      ConflictException,
    )
  })
  it('serializes concurrent admission and enforces the org cap', async () => {
    const id = randomUUID()
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(id)))
    const admitted = attempts.filter((item) => item.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof reserve>>
    >[]
    expect(admitted.length).toBeGreaterThan(0)
    expect(new Set(admitted.map((item) => item.value.id)).size).toBe(1)
    const [{ count }] = await database.query('SELECT count(*)::integer AS count FROM mcp_operation')
    expect(count).toBe(1)
    for (let i = 0; i < 3; i++) await reserve()
    await expect(reserve()).rejects.toMatchObject({ status: 429 })
  })
  it('does not replay an uncertain dispatch after its lease expires', async () => {
    const operation = await reserve()
    const claimed = (await store.claim())!
    expect(claimed.id).toBe(operation.id)
    expect(claimed.state).toBe('dispatching')
    expect(await store.renew(claimed)).toBe(true)
    await database.query("UPDATE mcp_operation SET lease_until = now() - interval '1 second'")
    expect(await store.claim()).toBeUndefined()
    expect(await store.read(identity, operation.id)).toMatchObject({ state: 'outcome_unknown', payload: null })
    expect(await store.renew(claimed)).toBe(false)
  })
  it('returns only an unstarted claim while preserving payload, capacity and lease fencing', async () => {
    const claim = async () => {
      const claimed = await store.claim()
      if (!claimed) throw new Error('Operation was not claimed')
      return claimed
    }
    const operation = await reserve()
    const first = await claim()
    await database.query("UPDATE mcp_operation SET lease_until = now() - interval '1 second', cancel_requested = true")
    await store.releaseClaim(first)
    expect(await store.read(identity, operation.id)).toMatchObject({
      state: 'queued',
      payload: operation.payload,
      cancel_requested: true,
      lease_owner: null,
    })
    expect(await database.query('SELECT operation_id FROM mcp_capacity_reservation')).toEqual([
      { operation_id: operation.id },
    ])
    const next = await claim()
    expect(next.lease_epoch).toBe(first.lease_epoch + 1)
    await store.releaseClaim(first)
    expect(await store.read(identity, operation.id)).toMatchObject({
      state: 'dispatching',
      lease_owner: next.lease_owner,
    })
    await store.save(next, {
      state: 'running',
      process_state: 'running',
      collection_state: 'collecting',
      box_id: 'box',
      execution_id: 'execution',
    })
    await store.releaseClaim(next)
    expect(await store.read(identity, operation.id)).toMatchObject({
      state: 'running',
      execution_id: 'execution',
      cancel_requested: true,
      payload: null,
      lease_owner: null,
    })
    const collector = await claim()
    await database.query("UPDATE mcp_operation SET deadline_at = now() - interval '1 second'")
    await store.expire()
    await store.releaseClaim(collector)
    expect(await store.read(identity, operation.id)).toMatchObject({
      state: 'outcome_unknown',
      execution_id: 'execution',
      cancel_requested: true,
      payload: null,
      lease_owner: null,
    })
    const cleanup = await claim()
    await store.releaseClaim(cleanup)
    expect(await store.claim()).toMatchObject({
      state: 'outcome_unknown',
      execution_id: 'execution',
      cancel_requested: true,
      lease_epoch: cleanup.lease_epoch + 1,
    })
    expect(await database.query('SELECT operation_id FROM mcp_capacity_reservation')).toEqual([
      { operation_id: operation.id },
    ])
  })
  it('keeps uncertain dispatches in both capacity caps after public metadata expires', async () => {
    for (let i = 0; i < 4; i++) await reserve()
    await database.query(`UPDATE mcp_operation SET state = 'outcome_unknown', payload = NULL,
      deadline_at = now() - interval '1 second', expires_at = now() - interval '1 second'`)
    await store.expire()
    expect(await database.query('SELECT * FROM mcp_operation')).toEqual([])
    await expect(reserve()).rejects.toMatchObject({ status: 429 })
    await expect(
      store.reserve(identity, 'create_box', randomUUID(), {}, { ...limits, global: 4 }),
    ).rejects.toMatchObject({ status: 429 })
  })
  it('releases capacity after a confirmed terminal result or queued cancellation', async () => {
    const first = await store.reserve(identity, 'exec_box', randomUUID(), {}, { ...limits, global: 1 })
    const claimed = await store.claim()
    if (!claimed) throw new Error('Operation was not claimed')
    await store.save(claimed, {
      state: 'succeeded',
      process_state: 'exited',
      collection_state: 'finished',
      exit_code: 0,
    })
    const second = await store.reserve(identity, 'exec_box', randomUUID(), {}, { ...limits, global: 1 })
    expect(second.id).not.toBe(first.id)
    await store.cancel(identity, second.id)
    await expect(store.reserve(identity, 'exec_box', randomUUID(), {}, { ...limits, global: 1 })).resolves.toBeDefined()
  })
  it('reclaims a known execution for cancellation after its deadline', async () => {
    await reserve()
    const first = await store.claim()
    if (!first) throw new Error('Operation was not claimed')
    await store.save(first, {
      state: 'running',
      process_state: 'running',
      collection_state: 'collecting',
      box_id: 'box',
      execution_id: 'execution',
    })
    await database.query("UPDATE mcp_operation SET deadline_at = now() - interval '1 second'")
    await store.expire()
    const cleanup = await store.claim()
    expect(cleanup).toMatchObject({ state: 'outcome_unknown', cancel_requested: true, execution_id: 'execution' })
    if (!cleanup) throw new Error('Cancellation was not claimed')
    await store.save(cleanup, { state: 'cancelled', process_state: 'exited', collection_state: 'interrupted' })
    expect(await database.query('SELECT * FROM mcp_capacity_reservation')).toEqual([])
  })
  it('retains cancellation intent when the worker deadline fires before the expiry sweep', async () => {
    await reserve()
    const claimed = await store.claim()
    if (!claimed) throw new Error('Operation was not claimed')
    await store.save(claimed, {
      state: 'running',
      process_state: 'running',
      collection_state: 'collecting',
      box_id: 'box',
      execution_id: 'execution',
    })
    await database.query("UPDATE mcp_operation SET deadline_at = now() - interval '1 second'")
    await store.save(claimed, { state: 'outcome_unknown', process_state: 'unknown', collection_state: 'interrupted' })
    expect(await store.read(identity, claimed.id)).toMatchObject({ cancel_requested: true })
    await database.query("UPDATE mcp_operation SET lease_until = now() - interval '1 second'")
    expect(await store.claim()).toMatchObject({ execution_id: 'execution', cancel_requested: true })
  })
  it('schedules cleanup when a known execution became uncertain before its deadline', async () => {
    await reserve()
    const claimed = await store.claim()
    if (!claimed) throw new Error('Operation was not claimed')
    await store.save(claimed, {
      state: 'outcome_unknown',
      process_state: 'unknown',
      collection_state: 'interrupted',
      box_id: 'box',
      execution_id: 'execution',
    })
    expect((await store.read(identity, claimed.id)).cancel_requested).toBe(false)
    await database.query("UPDATE mcp_operation SET deadline_at = now() - interval '1 second'")
    await store.expire()
    expect(await store.claim()).toMatchObject({
      state: 'outcome_unknown',
      execution_id: 'execution',
      cancel_requested: true,
    })
  })
  it('releases queued work that expires before dispatch', async () => {
    await store.reserve(identity, 'exec_box', randomUUID(), {}, { ...limits, global: 1 })
    await database.query("UPDATE mcp_operation SET deadline_at = now() - interval '1 second'")
    await store.expire()
    await expect(store.reserve(identity, 'exec_box', randomUUID(), {}, { ...limits, global: 1 })).resolves.toBeDefined()
  })
  it('reattaches a known execution with a new lease and fences stale writes', async () => {
    await reserve()
    const first = (await store.claim())!
    expect(
      await store.save(first, {
        state: 'running',
        process_state: 'running',
        collection_state: 'collecting',
        box_id: 'box',
        execution_id: 'exec',
      }),
    ).toBe(true)
    await database.query("UPDATE mcp_operation SET lease_until = now() - interval '1 second'")
    const next = (await store.claim())!
    expect(next).toMatchObject({ execution_id: 'exec', lease_epoch: first.lease_epoch + 1, payload: null })
    expect(
      await store.save(first, { state: 'failed', process_state: 'unknown', collection_state: 'unavailable' }),
    ).toBe(false)
    expect(
      await store.save(next, {
        state: 'succeeded',
        process_state: 'exited',
        collection_state: 'finished',
        exit_code: 0,
      }),
    ).toBe(true)
    expect((await store.read(identity, first.id)).completed_at).toBeInstanceOf(Date)
  })
  it('enforces creator/org reads and cancels queued work without dispatch', async () => {
    const operation = await reserve()
    await expect(store.read({ ...identity, userId: 'other' }, operation.id)).rejects.toBeInstanceOf(NotFoundException)
    await expect(store.read({ ...identity, organizationId: randomUUID() }, operation.id)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(await store.cancel(identity, operation.id)).toMatchObject({ state: 'cancelled', payload: null })
    expect(await store.claim()).toBeUndefined()
  })
  it('expires results explicitly and purges payloads when an organization is deleted', async () => {
    const operation = await reserve()
    await database.query("UPDATE mcp_operation SET expires_at = now() - interval '1 second'")
    await expect(store.read(identity, operation.id)).rejects.toMatchObject({ status: 410 })
    await database.query('DELETE FROM organization WHERE id = $1', [identity.organizationId])
    expect(await database.query('SELECT * FROM mcp_operation')).toEqual([])
    await database.query('INSERT INTO organization (id) VALUES ($1)', [identity.organizationId])
  })

  it('consumes a consent nonce once and enforces creator-scoped revocation in Postgres', async () => {
    const grants = new McpGrantStore(database)
    const input = {
      organization_id: identity.organizationId,
      user_id: identity.userId,
      client_id: 'client',
      client_name: 'Agent',
      resource: 'https://app.test/api/mcp',
      scopes: ['boxes:read'] as const,
      challenge_nonce: randomUUID(),
    }
    const grant = await grants.create({ ...input, scopes: [...input.scopes] })
    await expect(grants.create({ ...input, scopes: [...input.scopes] })).rejects.toMatchObject({ status: 409 })
    expect((await grants.read(grant.id)).organization_id).toBe(identity.organizationId)
    await expect(grants.revoke('other', grant.id)).rejects.toMatchObject({ status: 404 })
    await grants.revoke(identity.userId, grant.id)
    await expect(grants.read(grant.id)).rejects.toMatchObject({ status: 401 })
    expect((await grants.list(identity.userId))[0].revoked_at).toBeInstanceOf(Date)
  })
})
