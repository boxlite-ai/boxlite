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
import { TunnelDomain } from '../entities/tunnel-domain.entity'
import { DOMAIN_COUNT_LIMIT_CODE, SUBDOMAIN_TAKEN_CODE, SUBDOMAIN_TOO_SHORT_CODE } from '../errors/tunnel-domain.error'
import { AddTunnelDomain1792972800000 } from '../../migrations/pre-deploy/1792972800000-add-tunnel-domain-migration'
import { TunnelDomainService } from './tunnel-domain.service'
import { TunnelService } from './tunnel.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `tunnel_domain_${process.pid}_${randomUUID().replaceAll('-', '')}`
const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG = '00000000-0000-4000-8000-000000000002'
const APP_DOMAIN = 'app.boxlite.test'

function memoryRedis() {
  const values = new Map<string, string>()
  return {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    setex: (key: string, _ttl: number, value: string) => Promise.resolve(void values.set(key, value)),
    del: (key: string) => Promise.resolve(Number(values.delete(key))),
  }
}

describeIfDatabase('TunnelDomainService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let tunnels: TunnelService
  let service: TunnelDomainService
  let ownsSchema = false
  let minLength = 5

  const configService = {
    get: (key: string) => (key === 'tunnelDomain.appDomain' || key === 'tunnelDomain.appHost' ? APP_DOMAIN : undefined),
    getOrThrow: (key: string) => {
      switch (key) {
        case 'tunnelDomain.platformSubdomainMinLength':
          return minLength
        case 'proxy.domain':
          return 'proxy.boxlite.test'
        case 'proxy.protocol':
          return 'https'
        default:
          throw new Error(`unexpected config key ${key}`)
      }
    },
  }
  // Every box here sits in the default region, which has no proxy of its own.
  const regionService = { findOne: () => Promise.resolve(null) }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity, BoxMigration, Tunnel, TunnelDomain],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    // The domain table comes from its migration, the schema production runs.
    // The organization table has just its id; the migration adds the limit.
    await dataSource.query(`DROP TABLE "${schemaName}"."tunnel_domain"`)
    await dataSource.query(`CREATE TABLE "${schemaName}"."organization" ("id" uuid PRIMARY KEY)`)
    const runner = dataSource.createQueryRunner()
    try {
      await new AddTunnelDomain1792972800000().up(runner)
    } finally {
      await runner.release()
    }
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
    minLength = 5
    await dataSource.query(`DELETE FROM "${schemaName}"."tunnel_domain"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."tunnel"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."organization"`)
    await dataSource.query(`INSERT INTO "${schemaName}"."organization" ("id") VALUES ($1), ($2)`, [ORG, OTHER_ORG])
    tunnels = new TunnelService(dataSource.getRepository(Tunnel), memoryRedis() as never)
    service = new TunnelDomainService(dataSource, regionService as never, tunnels, configService as never)
  })

  async function makeBox(organizationId = ORG): Promise<Box> {
    const box = new Box('us', `domain-${randomUUID().slice(0, 8)}`)
    box.organizationId = organizationId
    box.osUser = 'boxlite'
    box.inboundEnabled = true
    await boxes.insert(box)
    return box
  }

  function setLimit(organizationId: string, limit: number) {
    return dataSource.query(`UPDATE "${schemaName}"."organization" SET "domain_count_limit" = $1 WHERE "id" = $2`, [
      limit,
      organizationId,
    ])
  }

  function heldNames(organizationId: string): Promise<{ hostname: string; box_id: string | null; port: number | null }[]> {
    return dataSource.query(
      `SELECT "hostname", "box_id", "port" FROM "${schemaName}"."tunnel_domain"
       WHERE "organization_id" = $1 ORDER BY "hostname"`,
      [organizationId],
    )
  }

  it('binds a name before its port is public, and resolves it once the port is declared', async () => {
    const box = await makeBox()

    await expect(service.bind(box, 3000, 'demo1')).resolves.toMatchObject({ url: `https://demo1.${APP_DOMAIN}` })

    await expect(tunnels.isPublicAccessAllowed(box.id, 3000)).resolves.toBe(false)
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()

    await tunnels.prepare(box.id, 3000)

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
  })

  it('keeps a private tunnel private when a domain is bound to its port', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')
    const prepared = await tunnels.prepare(box.id, 3000, false)

    await expect(tunnels.access(box.id, 3000, prepared.token!)).resolves.toMatchObject({ isPublic: false })
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()

    await tunnels.revoke(box.id, 3000)
    await tunnels.prepare(box.id, 3000)
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
  })

  it('routes several names to one port', async () => {
    await setLimit(ORG, 2)
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)

    await service.bind(box, 3000, 'first1')
    await service.bind(box, 3000, 'second')

    await expect(service.resolve(`first1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
    await expect(service.resolve(`second.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
    expect(await heldNames(ORG)).toEqual([
      { hostname: `first1.${APP_DOMAIN}`, box_id: box.id, port: 3000 },
      { hostname: `second.${APP_DOMAIN}`, box_id: box.id, port: 3000 },
    ])
  })

  it('repeats the same binding without a second name and keeps the count at one', async () => {
    const box = await makeBox()

    await service.bind(box, 3000, 'demo1')
    await expect(service.bind(box, 3000, 'demo1')).resolves.toMatchObject({ url: `https://demo1.${APP_DOMAIN}` })

    const held = await service.listHeld(ORG)
    expect(held).toMatchObject({ used: 1, limit: 1, remaining: 0, minLength: 5 })
    expect(held.domains).toEqual([
      { name: 'demo1', hostname: `demo1.${APP_DOMAIN}`, url: `https://demo1.${APP_DOMAIN}`, boxId: box.id, port: 3000 },
    ])
  })

  it('unbinds by name idempotently, keeps the name for the organization, and keeps the port public', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await service.unbind(ORG, 'demo1')
    await service.unbind(ORG, 'Demo1')

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
    await expect(tunnels.isPublicAccessAllowed(box.id, 3000)).resolves.toBe(true)
    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: null, port: null }])
    expect((await service.listHeld(ORG)).used).toBe(1)
  })

  it('refuses to unbind a name the organization does not hold', async () => {
    const mine = await makeBox()
    await tunnels.prepare(mine.id, 3000)
    await service.bind(mine, 3000, 'demo1')

    await expect(service.unbind(OTHER_ORG, 'demo1')).rejects.toMatchObject({ status: 404 })
    await expect(service.unbind(ORG, 'nobody')).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: mine.id, port: 3000 })
  })

  it('lets the same organization rebind a released name to another box port, at full allowance', async () => {
    const first = await makeBox()
    const second = await makeBox()
    await tunnels.prepare(second.id, 8080)
    await service.bind(first, 3000, 'demo1')
    await service.unbind(ORG, 'demo1')

    await expect(service.bind(second, 8080, 'demo1')).resolves.toMatchObject({ url: `https://demo1.${APP_DOMAIN}` })

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: second.id, port: 8080 })
    expect((await service.listHeld(ORG)).used).toBe(1)
  })

  it('moves a name bound to another of the organization ports, at full allowance', async () => {
    const first = await makeBox()
    const second = await makeBox()
    await service.bind(first, 3000, 'demo1')

    await expect(service.bind(second, 8080, `Demo1.${APP_DOMAIN}.`)).resolves.toMatchObject({
      name: 'demo1',
      boxId: second.id,
      port: 8080,
    })

    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: second.id, port: 8080 }])
  })

  it('keeps a name from every other organization, bound or released', async () => {
    const mine = await makeBox()
    const theirs = await makeBox(OTHER_ORG)
    await service.bind(mine, 3000, 'demo1')

    await expect(service.bind(theirs, 3000, 'demo1')).rejects.toMatchObject({
      status: 409,
      response: { code: SUBDOMAIN_TAKEN_CODE },
    })
    await service.unbind(ORG, 'demo1')
    await expect(service.bind(theirs, 3000, 'demo1')).rejects.toMatchObject({ status: 409 })

    expect(await heldNames(OTHER_ORG)).toEqual([])
  })

  it('refuses a new name once the allowance is used, and keeps the existing binding', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'first1')

    await expect(service.bind(box, 3000, 'second')).rejects.toMatchObject({
      status: 400,
      response: { code: DOMAIN_COUNT_LIMIT_CODE },
    })
    expect(await heldNames(ORG)).toEqual([{ hostname: `first1.${APP_DOMAIN}`, box_id: box.id, port: 3000 }])
  })

  it('applies the minimum length to new names only', async () => {
    const box = await makeBox()
    minLength = 2
    await service.bind(box, 3000, 'ab')
    await service.unbind(ORG, 'ab')
    minLength = 5

    await expect(service.bind(box, 3000, 'ab')).resolves.toMatchObject({ url: `https://ab.${APP_DOMAIN}` })
    await setLimit(ORG, 2)
    await expect(service.bind(box, 8080, 'cd')).rejects.toMatchObject({
      status: 400,
      response: { code: SUBDOMAIN_TOO_SHORT_CODE },
    })
  })

  it('admits only as many new names as the allowance, under concurrent claims', async () => {
    await setLimit(ORG, 2)
    const box = await makeBox()

    const outcomes = await Promise.allSettled([
      service.bind(box, 3001, 'name-one'),
      service.bind(box, 3002, 'name-two'),
      service.bind(box, 3003, 'name-three'),
    ])

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ response: { code: DOMAIN_COUNT_LIMIT_CODE } })
    expect(await heldNames(ORG)).toHaveLength(2)
  })

  it('gives a contested new name to exactly one organization', async () => {
    const mine = await makeBox()
    const theirs = await makeBox(OTHER_ORG)

    const outcomes = await Promise.allSettled([service.bind(mine, 3000, 'demo1'), service.bind(theirs, 3000, 'demo1')])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const rows: { organization_id: string }[] = await dataSource.query(
      `SELECT "organization_id" FROM "${schemaName}"."tunnel_domain"`,
    )
    expect(rows).toHaveLength(1)
  })

  it('keeps the binding through a revoke: the name answers nothing until the port is declared again', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await tunnels.revoke(box.id, 3000)

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: box.id, port: 3000 }])

    await tunnels.prepare(box.id, 3000)

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
  })

  it('releases every binding of a destroyed box and keeps the names', async () => {
    await setLimit(ORG, 2)
    const box = await makeBox()
    await service.bind(box, 3000, 'name-one')
    await service.bind(box, 8080, 'name-two')

    await service.releaseBoxBindings({ box })

    expect(await heldNames(ORG)).toEqual([
      { hostname: `name-one.${APP_DOMAIN}`, box_id: null, port: null },
      { hostname: `name-two.${APP_DOMAIN}`, box_id: null, port: null },
    ])
  })

  it('unbinds and keeps the name when the box row is deleted outright', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')

    await dataSource.query(`DELETE FROM "${schemaName}"."box" WHERE "id" = $1`, [box.id])

    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: null, port: 3000 }])
    expect((await service.listHeld(ORG)).domains).toEqual([
      { name: 'demo1', hostname: `demo1.${APP_DOMAIN}`, url: `https://demo1.${APP_DOMAIN}`, boxId: null, port: null },
    ])
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
  })

  it('stops resolving a name as soon as its box disables inbound access', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await boxes.update(box.id, { inboundEnabled: false })
    // The access verdict is cached for 3 seconds by design; a fresh service
    // shares the database but not that cache.
    const fresh = new TunnelDomainService(
      dataSource,
      regionService as never,
      new TunnelService(dataSource.getRepository(Tunnel), memoryRedis() as never),
      configService as never,
    )
    await expect(fresh.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
  })
})
