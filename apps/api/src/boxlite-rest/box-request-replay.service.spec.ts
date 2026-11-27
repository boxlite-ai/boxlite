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

  it('retains corrupt and oversized outcomes while allowing only completed-resource lookups', async () => {
    const key = randomUUID()
    const owner = await session(key)
    expect(await service.peekCompleted(org, 'u', 'op', key, 'fingerprint')).toBeUndefined()
    await owner.complete({ status: 201, body: 'x'.repeat(1024 * 1024) })
    await expect(session(key)).rejects.toMatchObject({ status: 422 })
    for (const response of [
      null,
      { status: 500, body: '' },
      { status: 201, body: '', headers: { cookie: 'secret' } },
      { status: 201, body: '', resource: { id: 'volume' } },
      { status: 201, body: '', encoding: 'utf16' },
      { status: 201, body: '', auditTargetId: { id: 'box' } },
    ]) {
      await redis.hset(record(key), 'response', JSON.stringify(response))
      expect(await service.peekCompleted(org, 'u', 'op', key, 'fingerprint')).toBeUndefined()
    }
    await redis.hset(
      record(key),
      'response',
      JSON.stringify({ status: 204, body: '', resource: { id: 'v', organizationId: org } }),
    )
    expect(await service.peekCompleted(org, 'u', 'op', key, 'fingerprint')).toMatchObject({
      status: 204,
      resource: { id: 'v' },
    })
    const replay = await session(key)
    expect(replay.isOwner).toBe(false)
    await replay.complete({ status: 204, body: '' })
    await replay.markUnknown()
    const unkeyed = await service.session(org, 'u', 'op', undefined, 'fingerprint')
    expect(unkeyed.isOwner).toBe(false)
    await unkeyed.heartbeat()
  })

  it('releases a reservation arriving after the caller deadline', async () => {
    const key = randomUUID()
    const delayed = new BoxRequestReplayService(redis)
    const resume = Promise.withResolvers<void>()
    const stored = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const connection = redis.duplicate()
    const evaluate = connection.eval.bind(connection)
    jest.spyOn(connection, 'eval').mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
      const result = await evaluate(...args)
      stored.resolve()
      await resume.promise
      return result
    })
    const cleanup = jest.spyOn(connection, 'eval')
    Object.assign(delayed, { ready: async () => connection })
    try {
      const pending = delayed.session(org, 'u', 'op', key, 'fingerprint')
      await stored.promise
      await expect(pending).rejects.toMatchObject({ status: 503 })
      cleanup.mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
        try {
          return await evaluate(...args)
        } finally {
          settled.resolve()
        }
      })
      resume.resolve()
      await settled.promise
      expect(await redis.exists(record(key))).toBe(0)
      expect((await session(key)).isOwner).toBe(true)
    } finally {
      resume.resolve()
      await connection.quit()
    }
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

  async function withIsolatedRedis(run: (client: Redis) => Promise<void>): Promise<void> {
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
    server.once('exit', (code) => ready.reject(new Error(`Test Redis exited with code ${code}`)))
    try {
      await ready.promise
      isolated = new Redis({ path: socket })
      await run(isolated)
    } finally {
      await isolated?.quit()
      if (server.pid && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit')
        server.kill()
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('replays with a Redis user that cannot run CONFIG', async () => {
    await withIsolatedRedis(async (isolated) => {
      await isolated.acl('SETUSER', 'replay', 'on', '>test-password', '~*', '+@all', '-config')
      const client = isolated.duplicate({ username: 'replay', password: 'test-password', lazyConnect: true })
      const engine = new BoxRequestReplayService(client)
      const key = randomUUID()
      try {
        const owner = await engine.session(org, 'u', 'op', key, 'fp')
        await owner.complete({ status: 201, body: 'original' })
        const replay = await engine.session(org, 'u', 'op', key, 'fp')
        expect(replay.response).toMatchObject({ status: 201, body: 'original' })
      } finally {
        engine.onModuleDestroy()
        client.disconnect()
      }
    })
  })

  it.each(['new', 'retryable'])('releases a %s reservation after a real Redis command timeout', async (state) => {
    await withIsolatedRedis(async (isolated) => {
      const engine = new BoxRequestReplayService(isolated)
      const reserve = (key: string, fingerprint = 'fp') => engine.session(org, 'u', 'op', key, fingerprint)
      try {
        const warm = await reserve(randomUUID())
        const key = randomUUID()
        if (state === 'retryable') {
          const previous = await reserve(key)
          await previous.markRetryable()
          await isolated.expire(record(key), 60)
        }
        await isolated.call('CLIENT', 'PAUSE', '1500', 'ALL')
        await expect(reserve(key)).rejects.toMatchObject({ status: 503 })
        // Redis resumes before the heartbeat is queued on the same connection as the abandoned claim.
        await isolated.ping()
        await warm.heartbeat()
        if (state === 'retryable') {
          await expect(reserve(key, 'changed')).rejects.toMatchObject({
            status: 409,
            response: { code: 'idempotency_request_mismatch' },
          })
        } else {
          expect(await isolated.exists(record(key))).toBe(0)
        }
        expect((await reserve(key)).isOwner).toBe(true)
        if (state === 'retryable') expect(await isolated.pttl(record(key))).toBeLessThan(60_000)
      } finally {
        engine.onModuleDestroy()
      }
    })
  })

  it('refuses capacity without discarding an existing execution fence', async () => {
    await withIsolatedRedis(async (isolated) => {
      await isolated.config('SET', 'maxmemory-policy', 'allkeys-lru')
      const unsafe = new BoxRequestReplayService(isolated)
      try {
        await expect(unsafe.session(org, 'u', 'op', randomUUID(), 'fp')).rejects.toMatchObject({ status: 503 })
      } finally {
        unsafe.onModuleDestroy()
      }
      await isolated.config('SET', 'maxmemory-policy', 'noeviction')
      const engine = new BoxRequestReplayService(isolated)
      try {
        const key = randomUUID()
        expect((await engine.session(org, 'u', 'op', key, 'fp')).isOwner).toBe(true)
        await isolated.config('SET', 'maxmemory', '1')
        await expect(engine.session(org, 'u', 'op', randomUUID(), 'fp')).rejects.toMatchObject({ status: 503 })
        await expect(engine.session(org, 'u', 'op', key, 'fp')).rejects.toMatchObject({ status: 409 })
      } finally {
        engine.onModuleDestroy()
      }
    })
  })
})
