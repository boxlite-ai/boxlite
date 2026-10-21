/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Tunnel } from '../entities/tunnel.entity'
import { TunnelService } from './tunnel.service'

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
    del: (key: string) => Promise.resolve(Number(values.delete(key))),
  }
}

describeIfDatabase('TunnelService revoke (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let service: TunnelService
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
    service = new TunnelService(dataSource.getRepository(Tunnel), memoryRedis() as never)
  })

  it('closes a public port at once, even behind a cached allowance', async () => {
    await service.declarePublic(boxId, 3000)
    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(true)

    await service.revoke(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(false)
  })

  it('leaves the other public ports of the box open', async () => {
    await service.declarePublic(boxId, 3000)
    await service.declarePublic(boxId, 8080)

    await service.revoke(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 8080)).resolves.toBe(true)
  })

  it('reopens a revoked port when it is declared again', async () => {
    await service.declarePublic(boxId, 3000)
    await service.revoke(boxId, 3000)

    await service.declarePublic(boxId, 3000)

    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(true)
  })

  it('accepts a repeated revoke and a port that was never declared', async () => {
    await service.declarePublic(boxId, 3000)
    await service.revoke(boxId, 3000)

    await expect(service.revoke(boxId, 3000)).resolves.toBeUndefined()
    await expect(service.revoke(boxId, 4000)).resolves.toBeUndefined()
    await expect(service.isPublicAccessAllowed(boxId, 3000)).resolves.toBe(false)
  })
})
