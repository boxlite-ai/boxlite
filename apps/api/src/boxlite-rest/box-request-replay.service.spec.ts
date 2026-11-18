/// <reference lib="es2024.promise" />
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import Redis from 'ioredis'
import { BoxRequestReplayService } from './box-request-replay.service'

const integration = process.env.REDIS_HOST ? describe : describe.skip
integration('Replay Redis ownership and storage failures', () => {
  const org = randomUUID()
  let redis: Redis
  let service: BoxRequestReplayService
  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    })
    await redis.ping()
    service = new BoxRequestReplayService(redis)
  })
  afterAll(async () => {
    service.onModuleDestroy()
    const keys = await redis.keys(`replay:${org}:*`)
    if (keys.length) await redis.del(...keys)
    await redis.quit()
  })
  const session = (key: string) => service.session(org, 'u', 'op', key, 'fingerprint')
  const record = (key: string) => `replay:${org}:u:op:${createHash('sha256').update(key).digest('hex')}`

  it('rejects stale owners and preserves absolute retention through unknown and late completion', async () => {
    const key = randomUUID()
    const stale = await session(key)
    await stale.markRetryable()
    const owner = await session(key)
    const ttl = await redis.pttl(record(key))
    await stale.complete({ status: 201, body: 'stale' })
    await expect(session(key)).rejects.toMatchObject({ status: 409 })
    await owner.markUnknown()
    await owner.heartbeat()
    await expect(session(key)).rejects.toMatchObject({ status: 422 })
    await owner.complete({ status: 201, body: 'original' })
    expect((await session(key)).response?.body).toBe('original')
    expect(await redis.pttl(record(key))).toBeLessThanOrEqual(ttl)
    await redis.hset(record(key), 'response', 'invalid-json')
    await expect(session(key)).rejects.toMatchObject({ status: 422 })
    await redis.del(record(key))
    expect((await session(key)).isOwner).toBe(true)
  })

  it('never sends a reservation after readiness has already timed out', async () => {
    const ready = Promise.withResolvers<Redis>()
    const settled = Promise.withResolvers<void>()
    const evaluate = jest.fn(async () => ['owner'])
    const slow = new BoxRequestReplayService(redis)
    Object.assign(slow, {
      ready: () => ready.promise.finally(settled.resolve),
    })
    await expect(slow.session(org, 'u', 'op', randomUUID(), 'fp')).rejects.toMatchObject({ status: 503 })
    // This is an in-process stand-in for the connection, not external data.
    const connection = { eval: evaluate } as unknown as Redis
    ready.resolve(connection)
    await settled.promise
    await nextTurn()
    expect(evaluate).not.toHaveBeenCalled()
    slow.onModuleDestroy()
  })

  it('refuses capacity without discarding an existing execution fence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'replay-capacity-'))
    const socket = join(directory, 'redis.sock')
    const server = spawn(
      'redis-server',
      ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--maxmemory-policy', 'noeviction'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const ready = Promise.withResolvers<void>()
    server.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Ready to accept connections')) ready.resolve()
    })
    server.once('error', ready.reject)
    let isolated: Redis | undefined
    let engine: BoxRequestReplayService | undefined
    try {
      await ready.promise
      isolated = new Redis({ path: socket })
      engine = new BoxRequestReplayService(isolated)
      const key = randomUUID()
      expect((await engine.session(org, 'u', 'op', key, 'fp')).isOwner).toBe(true)
      await isolated.config('SET', 'maxmemory', '1')
      await expect(engine.session(org, 'u', 'op', randomUUID(), 'fp')).rejects.toMatchObject({ status: 503 })
      await expect(engine.session(org, 'u', 'op', key, 'fp')).rejects.toMatchObject({ status: 409 })
    } finally {
      engine?.onModuleDestroy()
      await isolated?.quit()
      if (server.pid && server.exitCode === null) {
        const exited = once(server, 'exit')
        server.kill()
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})
