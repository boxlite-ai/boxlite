/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { McpOutputStore } from './mcp-output.store'
import { McpOperation } from './mcp-operation.store'

const integration = process.env.MCP_TEST_REDIS_URL ? describe : describe.skip
integration('McpOutputStore (Redis)', () => {
  let redis: Redis
  let output: McpOutputStore
  let operation: McpOperation
  beforeAll(() => {
    redis = new Redis(process.env.MCP_TEST_REDIS_URL!)
    output = new McpOutputStore(redis)
  })
  beforeEach(async () => {
    operation = { id: randomUUID(), organization_id: randomUUID(), lease_epoch: 1, completed_at: null } as McpOperation
    await output.lease(operation, Date.now() + 15000, true)
  })
  afterEach(async () => {
    await output.purgeOrganization(operation.organization_id)
  })
  afterAll(async () => {
    await redis.quit()
  })
  it('bounds stored output and replies and reports truncated cursors', async () => {
    for (let i = 0; i < 140; i++) await output.append(operation, 'stdout', 'x'.repeat(4096))
    const result = await output.read(operation, 0)
    expect(result).toMatchObject({
      output_status: 'available',
      truncated: true,
      cursor_lost: true,
      output_complete: false,
    })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024)
    const keys = await redis.keys(`mcp:output:{${operation.organization_id}}:*:meta`)
    expect(Number(await redis.hget(keys[0], 'bytes'))).toBeLessThanOrEqual(512 * 1024)
    expect((await output.read(operation, result.next_cursor!)).chunks?.[0].cursor).toBeGreaterThan(result.next_cursor!)
  })
  it('fences stale collectors and marks a reconnect segment as uncertain', async () => {
    await output.append(operation, 'stdout', 'first')
    const next = { ...operation, lease_epoch: 2 }
    await output.lease(next, Date.now() + 15000)
    await expect(output.append(operation, 'stdout', 'stale')).rejects.toThrow('lease lost')
    await output.append(next, 'stderr', 'second')
    expect(await output.read(next, 0)).toMatchObject({
      uncertain_segments: true,
      output_complete: null,
      chunks: [
        { text: 'first', segment: 1 },
        { text: 'second', segment: 2 },
      ],
    })
  })
  it('preserves Unicode and distinguishes unknown completeness from known replacement', async () => {
    await output.append(operation, 'stdout', '中文🙂')
    expect(await output.read(operation, 0)).toMatchObject({ output_complete: null, chunks: [{ text: '中文🙂' }] })
    await output.append(operation, 'stderr', '\uFFFD')
    expect(await output.read(operation, 0)).toMatchObject({ output_complete: false, utf8_replacement: true })
  })
  it('does not recreate vanished output and purges/fences organization output', async () => {
    await output.purgeOrganization(operation.organization_id)
    await expect(output.append(operation, 'stdout', 'after delete')).rejects.toThrow('lease lost')
    await expect(output.lease({ ...operation, lease_epoch: 2 }, Date.now() + 15000)).rejects.toThrow('lease lost')
    expect(await output.read(operation, 0)).toMatchObject({ output_status: 'unavailable' })
    operation.completed_at = new Date(Date.now() - 3601000)
    expect(await output.read(operation, 0)).toMatchObject({ output_status: 'expired' })
  })
})
