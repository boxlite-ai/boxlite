/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { NotFoundException } from '@nestjs/common'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Tunnel } from '../entities/tunnel.entity'
import { Domain } from '../entities/domain.entity'
import { DOMAIN_COUNT_LIMIT_CODE, SUBDOMAIN_TAKEN_CODE, SUBDOMAIN_TOO_SHORT_CODE } from '../errors/domain.error'
import { AddDomain1792972800000 } from '../../migrations/pre-deploy/1792972800000-add-domain-migration'
import { DomainService } from './domain.service'
import { TunnelService } from './tunnel.service'
import { PreviewController } from '../controllers/preview.controller'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `domain_${process.pid}_${randomUUID().replaceAll('-', '')}`
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

describeIfDatabase('DomainService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let tunnels: TunnelService
  let service: DomainService
  let preview: PreviewController
  let ownsSchema = false
  let minLength = 5

  const configService = {
    get: (key: string) => (key === 'domain.appDomain' || key === 'domain.appHost' ? APP_DOMAIN : undefined),
    getOrThrow: (key: string) => {
      switch (key) {
        case 'domain.platformSubdomainMinLength':
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
      entities: [Box, BoxLastActivity, BoxMigration, Tunnel, Domain],
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
    await dataSource.query(`DROP TABLE "${schemaName}"."domain"`)
    await dataSource.query(`CREATE TABLE "${schemaName}"."organization" ("id" uuid PRIMARY KEY)`)
    const runner = dataSource.createQueryRunner()
    try {
      await new AddDomain1792972800000().up(runner)
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
    await dataSource.query(`DELETE FROM "${schemaName}"."domain"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."tunnel"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."organization"`)
    await dataSource.query(`INSERT INTO "${schemaName}"."organization" ("id") VALUES ($1), ($2)`, [ORG, OTHER_ORG])
    tunnels = new TunnelService(dataSource.getRepository(Tunnel), memoryRedis() as never)
    service = new DomainService(dataSource, regionService as never, configService as never)
    preview = createPreview(tunnels)
  })

  function createPreview(tunnelService: TunnelService): PreviewController {
    return new PreviewController(
      null as never,
      null as never,
      null as never,
      tunnelService,
      null as never,
      null as never,
      null as never,
      service,
    )
  }

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

  function heldNames(
    organizationId: string,
  ): Promise<{ hostname: string; box_id: string | null; port: number | null }[]> {
    return dataSource.query(
      `SELECT "hostname", "box_id", "port" FROM "${schemaName}"."domain"
       WHERE "organization_id" = $1 ORDER BY "hostname"`,
      [organizationId],
    )
  }

  it('hostname contract: unbind selects the exact held hostname independently of the configured suffix', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')
    await dataSource.query(
      `INSERT INTO "domain" ("hostname", "kind", "organization_id", "box_id", "port") VALUES ($1, 'platform', $2, $3, 3000)`,
      ['demo1.other.example', ORG, box.id],
    )
    await expect(service.unbind(OTHER_ORG, 'demo1.other.example')).rejects.toMatchObject({ status: 404 })
    await expect(service.unbind(ORG, 'DEMO1.Other.Example.')).resolves.toBeUndefined()
    expect(await heldNames(ORG)).toEqual([
      { hostname: `demo1.${APP_DOMAIN}`, box_id: box.id, port: 3000 },
      { hostname: 'demo1.other.example', box_id: null, port: null },
    ])
  })

  it('typed target contract: migration stores App targets, rejects mixed shapes and preserves target lifecycles', async () => {
    const columns: { column_name: string }[] = await dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'domain'`,
      [schemaName],
    )
    expect(columns.map((column) => column.column_name)).toEqual(expect.arrayContaining(['target_type', 'app_id']))
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')
    const insertApp = (type: string, app: string, boxId: string | null = null, port: number | null = null) =>
      dataSource.query(
        `INSERT INTO "domain" ("hostname", "kind", "organization_id", "target_type", "app_id", "box_id", "port")
         VALUES ('shop1.app.boxlite.test', 'platform', $1, $2, $3, $4, $5)`,
        [ORG, type, app, boxId, port],
      )
    for (const [type, app, boxId, port] of [
      ['unknown', 'shop', null, null],
      ['app', '', null, null],
      ['app', '   ', null, null],
      ['app', '\t\n', null, null],
      ['app', 'shop', box.id, 3000],
      ['app', 'shop', null, 3000],
      ['box', 'shop', box.id, 3000],
    ] as const) {
      await expect(insertApp(type, app, boxId, port)).rejects.toMatchObject({ code: '23514' })
    }
    await insertApp('app', box.id)
    await expect(service.resolve('shop1.app.boxlite.test')).resolves.toEqual({ type: 'app', app: box.id })
    expect((await service.listHeld(ORG)).domains).toEqual(
      expect.arrayContaining([
        {
          hostname: 'shop1.app.boxlite.test',
          url: 'https://shop1.app.boxlite.test',
          target: { type: 'app', app: box.id },
        },
      ]),
    )
    await expect(preview.resolveDomain('shop1.app.boxlite.test')).rejects.toBeInstanceOf(NotFoundException)
    await boxes.delete(box.id)
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
    await expect(service.resolve('shop1.app.boxlite.test')).resolves.toEqual({ type: 'app', app: box.id })
    await service.unbind(ORG, 'shop1.app.boxlite.test')
    await expect(service.resolve('shop1.app.boxlite.test')).resolves.toBeNull()
    const replacement = await makeBox()
    await service.bind(replacement, 8080, 'shop1')
    await expect(service.resolve('shop1.app.boxlite.test')).resolves.toEqual({
      type: 'box',
      box: replacement.id,
      port: 8080,
    })
    const [stored] = await dataSource.query(
      `SELECT target_type, app_id FROM "domain" WHERE hostname = 'shop1.app.boxlite.test'`,
    )
    expect(stored).toEqual({ target_type: 'box', app_id: null })
  })

  it('resolves the stored target independently of tunnel publication', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')
    const target = { type: 'box', box: box.id, port: 3000 }

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual(target)

    await tunnels.prepare(box.id, 3000, false)
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual(target)

    await tunnels.revoke(box.id, 3000)
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual(target)
  })

  it('binds a name before its port is public, and admits preview once the port is declared', async () => {
    const box = await makeBox()

    await expect(service.bind(box, 3000, 'demo1')).resolves.toMatchObject({ url: `https://demo1.${APP_DOMAIN}` })

    await expect(tunnels.isPublicAccessAllowed(box.id, 3000)).resolves.toBe(false)
    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).rejects.toBeInstanceOf(NotFoundException)

    await tunnels.prepare(box.id, 3000)

    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
  })

  it('keeps a private tunnel private when a domain is bound to its port', async () => {
    const box = await makeBox()
    await service.bind(box, 3000, 'demo1')
    const prepared = await tunnels.prepare(box.id, 3000, false)

    await expect(tunnels.access(box.id, 3000, prepared.token!)).resolves.toMatchObject({ isPublic: false })
    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).rejects.toBeInstanceOf(NotFoundException)

    await tunnels.revoke(box.id, 3000)
    await tunnels.prepare(box.id, 3000)
    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
  })

  it('routes several names to one port', async () => {
    await setLimit(ORG, 2)
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)

    await service.bind(box, 3000, 'first1')
    await service.bind(box, 3000, 'second')

    await expect(preview.resolveDomain(`first1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
    await expect(preview.resolveDomain(`second.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
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
      {
        hostname: `demo1.${APP_DOMAIN}`,
        url: `https://demo1.${APP_DOMAIN}`,
        target: { type: 'box', box: box.id, port: 3000 },
      },
    ])
  })

  it('unbinds by name idempotently, keeps the name for the organization, and keeps the port public', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await service.unbind(ORG, `demo1.${APP_DOMAIN}`)
    await service.unbind(ORG, `Demo1.${APP_DOMAIN}`)

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
    await expect(tunnels.isPublicAccessAllowed(box.id, 3000)).resolves.toBe(true)
    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: null, port: null }])
    expect((await service.listHeld(ORG)).used).toBe(1)
  })

  it('refuses to unbind a name the organization does not hold', async () => {
    const mine = await makeBox()
    await tunnels.prepare(mine.id, 3000)
    await service.bind(mine, 3000, 'demo1')

    await expect(service.unbind(OTHER_ORG, `demo1.${APP_DOMAIN}`)).rejects.toMatchObject({ status: 404 })
    await expect(service.unbind(ORG, `nobody.${APP_DOMAIN}`)).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ type: 'box', box: mine.id, port: 3000 })
  })

  it('lets the same organization rebind a released name to another box port, at full allowance', async () => {
    const first = await makeBox()
    const second = await makeBox()
    await tunnels.prepare(second.id, 8080)
    await service.bind(first, 3000, 'demo1')
    await service.unbind(ORG, `demo1.${APP_DOMAIN}`)

    await expect(service.bind(second, 8080, 'demo1')).resolves.toMatchObject({ url: `https://demo1.${APP_DOMAIN}` })

    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ type: 'box', box: second.id, port: 8080 })
    expect((await service.listHeld(ORG)).used).toBe(1)
  })

  it('moves a name bound to another of the organization ports, at full allowance', async () => {
    const first = await makeBox()
    const second = await makeBox()
    await service.bind(first, 3000, 'demo1')

    await expect(service.bind(second, 8080, `Demo1.${APP_DOMAIN}.`)).resolves.toMatchObject({
      hostname: `demo1.${APP_DOMAIN}`,
      target: { type: 'box', box: second.id, port: 8080 },
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
    await service.unbind(ORG, `demo1.${APP_DOMAIN}`)
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
    await service.unbind(ORG, `ab.${APP_DOMAIN}`)
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
      `SELECT "organization_id" FROM "${schemaName}"."domain"`,
    )
    expect(rows).toHaveLength(1)
  })

  it('keeps the binding through a revoke: the name answers nothing until the port is declared again', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await tunnels.revoke(box.id, 3000)

    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).rejects.toBeInstanceOf(NotFoundException)
    expect(await heldNames(ORG)).toEqual([{ hostname: `demo1.${APP_DOMAIN}`, box_id: box.id, port: 3000 }])

    await tunnels.prepare(box.id, 3000)

    await expect(preview.resolveDomain(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ boxId: box.id, port: 3000 })
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
      { hostname: `demo1.${APP_DOMAIN}`, url: `https://demo1.${APP_DOMAIN}`, target: null },
    ])
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toBeNull()
  })

  it('keeps the target but refuses preview when its box disables inbound access', async () => {
    const box = await makeBox()
    await tunnels.prepare(box.id, 3000)
    await service.bind(box, 3000, 'demo1')

    await boxes.update(box.id, { inboundEnabled: false })
    // The access verdict is cached for 3 seconds by design; a fresh service
    // shares the database but not that cache.
    const fresh = createPreview(new TunnelService(dataSource.getRepository(Tunnel), memoryRedis() as never))
    await expect(service.resolve(`demo1.${APP_DOMAIN}`)).resolves.toEqual({ type: 'box', box: box.id, port: 3000 })
    await expect(fresh.resolveDomain(`demo1.${APP_DOMAIN}`)).rejects.toBeInstanceOf(NotFoundException)
  })
})
