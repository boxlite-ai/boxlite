/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Tunnel } from '../entities/tunnel.entity'
import { TunnelService } from './tunnel.service'
import { AddTunnelAuth1791100000000 } from '../../migrations/pre-deploy/1791100000000-add-tunnel-auth-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `tunnel_revoke_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-0000000000ff'

// Only the three commands TunnelService issues, so the verdict cache can be
// observed going stale: a revoke that leaves it behind keeps the port open.
function memoryRedis() {
  const values = new Map<string, string>()
  return {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    setex: (key: string, _ttl: number, value: string) => Promise.resolve(void values.set(key, value)),
    del: (...keys: string[]) => Promise.resolve(keys.filter((key) => values.delete(key)).length),
    // Stands in for the TTL lapsing after a change prepare/revoke does not evict.
    expire: () => values.clear(),
  }
}

describeIfDatabase('TunnelService revoke (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let service: TunnelService
  let redis: ReturnType<typeof memoryRedis>
  let boxId: string
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity, BoxMigration, Tunnel],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }

    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."tunnel"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    const target = new Box('us', `inbound-${randomUUID().slice(0, 8)}`)
    target.organizationId = organizationId
    target.osUser = 'boxlite'
    target.inboundEnabled = true
    await boxes.insert(target)
    boxId = target.id
    redis = memoryRedis()
    service = new TunnelService(dataSource.getRepository(Tunnel), redis as never)
  })

  it('closes a public port at once, even behind a cached allowance', async () => {
    await service.prepare(boxId, 3000)
    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(true)

    await service.revoke(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(false)
  })

  it('leaves the other public ports of the box open', async () => {
    await service.prepare(boxId, 3000)
    await service.prepare(boxId, 8080)

    await service.revoke(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 8080)).resolves.toBe(true)
  })

  it('reopens a revoked port when it is declared again', async () => {
    await service.prepare(boxId, 3000)
    await service.revoke(boxId, 3000)

    await service.prepare(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(true)
  })

  it('accepts a repeated revoke and a port that was never declared', async () => {
    await service.prepare(boxId, 3000)
    await service.revoke(boxId, 3000)

    await expect(service.revoke(boxId, 3000)).resolves.toBeUndefined()
    await expect(service.revoke(boxId, 4000)).resolves.toBeUndefined()
    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(false)
  })

  it('persists only a verifier and mask, returns the full token once, and isolates ports', async () => {
    const created = await service.prepare(boxId, 3000, false)
    expect(created.token).toMatch(/^blt_[A-Za-z0-9_-]{43}$/)
    const row = await dataSource.getRepository(Tunnel).findOneByOrFail({ boxId, port: 3000 })
    expect(JSON.stringify(row)).not.toContain(created.token)
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await service.prepare(boxId, 3000, false)).toEqual({ isPublic: false, token: row.tokenMask })
    await expect(service.access(boxId, 3000, created.token!)).resolves.toMatchObject({ id: row.id, isPublic: false })
    await service.prepare(boxId, 4000, false)
    await expect(service.access(boxId, 4000, created.token!)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(false)
    await expect(service.prepare(boxId, 3000)).rejects.toBeInstanceOf(ConflictException)
  })

  it('migrates an existing public declaration without changing its access', async () => {
    await service.prepare(boxId, 3000)
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
      const migration = new AddTunnelAuth1791100000000()
      await migration.down(runner)
      await migration.up(runner)
      await expect(service.access(boxId, 3000)).resolves.toMatchObject({ isPublic: true, authGeneration: 1 })
      await expect(service.prepare(boxId, 3000)).resolves.toEqual({ isPublic: true, token: null })
    } finally {
      await runner.release()
    }
  })

  it('has exactly one token recipient under concurrent creation', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => service.prepare(boxId, 3000, false)))
    const full = results.filter((result) => !result.token!.includes('*'))
    expect(full).toHaveLength(1)
    await expect(service.access(boxId, 3000, full[0].token!)).resolves.toMatchObject({ isPublic: false })
    expect(new Set(results.filter((result) => result.token!.includes('*')).map((result) => result.token)).size).toBe(1)
  })

  it('keeps tokens across stop/resume and inbound changes, rotates only on explicit recreation', async () => {
    const created = await service.prepare(boxId, 3000, false)
    const before = await service.access(boxId, 3000, created.token!)
    await boxes.update(boxId, { state: 'stopped' as never })
    await expect(service.access(boxId, 3000, created.token!)).resolves.toEqual(before)
    await boxes.update(boxId, { inboundEnabled: false })
    redis.expire()
    await expect(service.access(boxId, 3000, created.token!)).rejects.toBeInstanceOf(NotFoundException)
    await boxes.update(boxId, { inboundEnabled: true, state: 'started' as never })
    redis.expire()
    await expect(service.access(boxId, 3000, created.token!)).resolves.toEqual(before)
    await service.revoke(boxId, 3000)
    await service.revoke(boxId, 3000)
    await expect(service.access(boxId, 3000, created.token!)).rejects.toBeInstanceOf(NotFoundException)
    const recreated = await service.prepare(boxId, 3000, false)
    expect(recreated.token).not.toEqual(created.token)
    await expect(service.access(boxId, 3000, created.token!)).rejects.toBeInstanceOf(ForbiddenException)
    const after = await service.access(boxId, 3000, recreated.token!)
    expect(after.authGeneration).toBeGreaterThan(before.authGeneration)
    await service.revoke(boxId, 3000)
    await expect(service.prepare(boxId, 3000)).resolves.toEqual({ isPublic: true, token: null })
  })
})
