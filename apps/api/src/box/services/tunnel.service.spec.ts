/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { TunnelService } from './tunnel.service'

function makeService() {
  const builder = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  }
  const repository = {
    query: jest.fn().mockResolvedValue([{ id: 'tunnel-1' }]),
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  }
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  }
  return { service: new TunnelService(repository as never, redis as never), repository, builder, redis }
}

describe('TunnelService', () => {
  it('stores a login handoff under a hash and consumes it once', async () => {
    const stored = new Map<string, string>()
    const redis = {
      set: jest.fn(async (key: string, value: string) => {
        stored.set(key, value)
      }),
      getdel: jest.fn(async (key: string) => {
        const value = stored.get(key)
        stored.delete(key)
        return value ?? null
      }),
    }
    const service = new TunnelService(null as never, redis as never)
    const ticket = await service.issueHandoff('signed-browser-grant')
    const [key] = [...stored.keys()]
    expect(key).not.toContain(ticket)
    expect(redis.set).toHaveBeenCalledWith(key, 'signed-browser-grant', 'EX', 30)
    await expect(service.consumeHandoff(ticket)).resolves.toBe('signed-browser-grant')
    await expect(service.consumeHandoff(ticket)).rejects.toBeInstanceOf(ForbiddenException)
  })
  it('declares one public port through an atomic conflict-aware write', async () => {
    const { service, repository } = makeService()

    await service.prepare('AbCdEf123456', 3000)

    expect(repository.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT ("box_id", "port") DO UPDATE'), [
      'AbCdEf123456',
      3000,
      'public',
      null,
      null,
    ])
  })

  it('does not replace a private tunnel or accept an invalid port', async () => {
    const { service, repository } = makeService()
    repository.query.mockResolvedValue([])

    await expect(service.prepare('AbCdEf123456', 3000)).rejects.toBeInstanceOf(ConflictException)
    await expect(service.prepare('AbCdEf123456', 0)).rejects.toThrow('Invalid tunnel port')
    expect(repository.query).toHaveBeenCalledTimes(1)
  })

  // 22222 was reserved for the runner's web terminal, which the dashboard no
  // longer reaches through the proxy; it is now an ordinary guest port.
  it('declares port 22222 like any other port', async () => {
    const { service, repository } = makeService()

    await service.prepare('AbCdEf123456', 22222)

    expect(repository.query).toHaveBeenCalledWith(expect.any(String), ['AbCdEf123456', 22222, 'public', null, null])
  })

  it('admits only an active public tunnel of a box with inbound enabled', async () => {
    const { service, builder } = makeService()
    builder.getOne
      .mockResolvedValueOnce({ id: 'tunnel-1', accessMode: 'public', tokenHash: null, authGeneration: 1 })
      .mockResolvedValueOnce({ id: 'tunnel-2', accessMode: 'private', tokenHash: 'hash', authGeneration: 1 })

    await expect(service.isPublicAccessAllowed('AbCdEf123456', 3000)).resolves.toBe(true)
    await expect(service.isPublicAccessAllowed('AbCdEf123456', 4000)).resolves.toBe(false)
    await expect(service.isPublicAccessAllowed('AbCdEf123456', 5000)).resolves.toBe(false)

    expect(builder.where).toHaveBeenCalledWith('tunnel.box_id = :boxId', { boxId: 'AbCdEf123456' })
    expect(builder.andWhere).toHaveBeenCalledWith('tunnel.port = :port', { port: 3000 })
    expect(builder.andWhere).toHaveBeenCalledWith('tunnel.revoked_at IS NULL')
    expect(builder.andWhere).toHaveBeenCalledWith('box.inboundEnabled = true')
  })

  it('caches both lookups briefly and answers from the cache', async () => {
    const { service, repository, redis } = makeService()
    const { service: cachedService, repository: cachedRepository, redis: cachedRedis } = makeService()
    cachedRedis.get.mockResolvedValueOnce(JSON.stringify({ accessMode: 'public' })).mockResolvedValueOnce('null')

    await expect(service.isPublicAccessAllowed('AbCdEf123456', 3000)).resolves.toBe(false)
    await expect(cachedService.isPublicAccessAllowed('AbCdEf123456', 3000)).resolves.toBe(true)
    await expect(cachedService.isPublicAccessAllowed('AbCdEf123456', 3000)).resolves.toBe(false)

    expect(redis.setex).toHaveBeenCalledWith('preview:tunnel-access:AbCdEf123456:3000', 3, 'null')
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1)
    expect(cachedRepository.createQueryBuilder).not.toHaveBeenCalled()
  })

  it('evicts the current and legacy cache entries when the port is declared', async () => {
    const { service, redis } = makeService()

    await service.prepare('AbCdEf123456', 3000)

    expect(redis.del).toHaveBeenCalledWith(
      'preview:tunnel-access:AbCdEf123456:3000',
      'preview:tunnel:AbCdEf123456:3000',
    )
  })

  it('ignores any access token on a public tunnel', async () => {
    const { service, builder } = makeService()
    builder.getOne.mockResolvedValue({ id: 'tunnel-1', accessMode: 'public', tokenHash: null, authGeneration: 1 })

    await expect(service.access('AbCdEf123456', 3000, 'not-a-tunnel-token')).resolves.toMatchObject({ isPublic: true })
  })

  it('caches the tunnel lookup per box and port until revoke', async () => {
    const values = new Map<string, string>()
    const { service, repository, builder, redis } = makeService()
    redis.get.mockImplementation(async (key: string) => values.get(key) ?? null)
    redis.setex.mockImplementation(async (key: string, _ttl: number, value: string) => void values.set(key, value))
    redis.del.mockImplementation(async (...keys: string[]) => keys.filter((key) => values.delete(key)).length)
    const token = `blt_${'a'.repeat(43)}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    builder.getOne.mockResolvedValue({ id: 'tunnel-1', accessMode: 'private', tokenHash, authGeneration: 1 })

    await service.access('AbCdEf123456', 3000, token)
    await service.access('AbCdEf123456', 3000, token)
    expect(builder.getOne).toHaveBeenCalledTimes(1)
    expect([...values.keys()].join()).not.toContain(token)

    builder.getOne.mockResolvedValue(null)
    await service.revoke('AbCdEf123456', 3000)
    expect(repository.query).toHaveBeenCalled()
    await expect(service.access('AbCdEf123456', 3000, token)).rejects.toBeInstanceOf(NotFoundException)
    expect(builder.getOne).toHaveBeenCalledTimes(2)
  })
})
