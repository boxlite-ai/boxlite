/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { BoxEndpointService } from './box-endpoint.service'
import { AddBoxEndpoints1790076000000 } from '../../migrations/pre-deploy/1790076000000-add-box-endpoints-migration'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip

describeWithDatabase('BoxEndpointService (real Postgres)', () => {
  const schema = `box_endpoints_${randomUUID().replaceAll('-', '')}`
  const org = randomUUID()
  const otherOrg = randomUUID()
  let database: DataSource
  let endpoints: BoxEndpointService
  const migration = new AddBoxEndpoints1790076000000()

  beforeAll(async () => {
    database = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema}` },
    }).initialize()
    await database.query(`CREATE SCHEMA "${schema}"`)
    await database.query(`CREATE TABLE "box" (
      "id" varchar(12) PRIMARY KEY, "name" varchar, "organizationId" uuid, "region" varchar,
      "state" varchar DEFAULT 'started', "desiredState" varchar DEFAULT 'started'
    )`)
    await database.query(`CREATE TABLE "region" ("id" varchar PRIMARY KEY, "proxyUrl" varchar)`)
    const runner = database.createQueryRunner()
    try {
      await migration.up(runner)
    } finally {
      await runner.release()
    }
    endpoints = new BoxEndpointService(database, {
      getOrThrow: (key: string) => (key === 'proxy.protocol' ? 'https' : 'proxy.example.com'),
    } as never)
  })

  afterAll(async () => {
    if (!database?.isInitialized) return
    try {
      await database.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await database.destroy()
    }
  })

  beforeEach(async () => {
    await database.query(`TRUNCATE "box_endpoint", "box", "region"`)
    await database.query(`INSERT INTO "region" VALUES ('west', NULL), ('east', 'https://proxy.east.example.com:8443')`)
    await database.query(
      `INSERT INTO "box" ("id", "name", "organizationId", "region") VALUES
      ('AbCdEf123456', 'fleet', $1, 'west'), ('Rebind123456', 'second', $1, 'west'),
      ('Other1234567', 'fleet', $2, 'west'), ('Region123456', 'east', $1, 'east')`,
      [org, otherOrg],
    )
  })

  const bind = (name = 'fleet') => endpoints.bind(org, name, { boxIdOrName: 'fleet', port: 8080 })

  it('binds a box name inside its organization and lists only that organization', async () => {
    await expect(bind()).resolves.toMatchObject({
      name: 'fleet',
      boxId: 'AbCdEf123456',
      port: 8080,
      url: 'https://app-fleet.proxy.example.com',
      enabled: true,
    })
    expect(await endpoints.list(org)).toHaveLength(1)
    expect(await endpoints.list(otherOrg)).toEqual([])
    await expect(endpoints.bind(otherOrg, 'other', { boxIdOrName: 'AbCdEf123456', port: 80 })).rejects.toMatchObject({
      status: 404,
    })
  })

  it('atomically arbitrates simultaneous claims from different tenants', async () => {
    const results = await Promise.allSettled([
      bind(),
      endpoints.bind(otherOrg, 'fleet', { boxIdOrName: 'fleet', port: 80 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(await database.query(`SELECT * FROM "box_endpoint"`)).toHaveLength(1)
  })

  it('revokes immediately, reserves the name, and permits the owner to rebind', async () => {
    const original = await bind()
    await expect(endpoints.revoke(otherOrg, 'fleet')).rejects.toMatchObject({ status: 404 })
    await endpoints.revoke(org, 'fleet')
    await endpoints.revoke(org, 'fleet')
    await expect(endpoints.resolve('fleet')).rejects.toMatchObject({ status: 404 })
    await expect(endpoints.bind(otherOrg, 'fleet', { boxIdOrName: 'fleet', port: 80 })).rejects.toMatchObject({
      status: 409,
    })
    const rebound = await endpoints.bind(org, 'fleet', { boxIdOrName: 'second', port: 3000 })
    expect(rebound.url).toBe(original.url)
    await expect(endpoints.resolve('fleet')).resolves.toMatchObject({
      boxId: 'Rebind123456',
      port: 3000,
      enabled: true,
    })
  })

  it('uses the regional origin and scopes resolution to that region', async () => {
    await expect(endpoints.bind(org, 'fleet', { boxIdOrName: 'east', port: 80 })).resolves.toMatchObject({
      url: 'https://app-fleet.proxy.east.example.com:8443',
    })
    await expect(endpoints.resolve('fleet', 'east')).resolves.toMatchObject({ region: 'east' })
    await expect(endpoints.resolve('fleet', 'west')).rejects.toMatchObject({ status: 404 })
    await expect(bind()).rejects.toMatchObject({ status: 409 })
  })

  it.each([
    ['organizationId', otherOrg],
    ['region', 'east'],
    ['state', 'destroyed'],
    ['desiredState', 'destroyed'],
  ])('invalidates resolution when the box changes %s', async (column, value) => {
    await bind()
    await database.query(`UPDATE "box" SET "${column}" = $1 WHERE "id" = 'AbCdEf123456'`, [value])
    await expect(endpoints.resolve('fleet')).rejects.toMatchObject({ status: 404 })
  })

  it('retains name ownership when the target box is deleted', async () => {
    await bind()
    await database.query(`DELETE FROM "box" WHERE "id" = 'AbCdEf123456'`)
    expect(await endpoints.list(org)).toEqual([expect.objectContaining({ name: 'fleet', boxId: null })])
    await expect(endpoints.resolve('fleet')).rejects.toMatchObject({ status: 404 })
    await expect(endpoints.bind(otherOrg, 'fleet', { boxIdOrName: 'fleet', port: 80 })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('keeps the issued URL when the regional configuration changes', async () => {
    const original = await bind()
    await database.query(`UPDATE "region" SET "proxyUrl" = 'https://new.example.com' WHERE "id" = 'west'`)
    expect((await bind()).url).toBe(original.url)
  })

  it('rejects invalid regional proxy configuration', async () => {
    await database.query(`UPDATE "region" SET "proxyUrl" = 'https://proxy.example.com/path' WHERE "id" = 'west'`)
    await expect(bind()).rejects.toMatchObject({ status: 400 })
  })

  it('enforces name and port constraints at the database boundary', async () => {
    await expect(bind('Invalid')).rejects.toMatchObject({ code: '23514' })
    await expect(endpoints.bind(org, 'fleet', { boxIdOrName: 'fleet', port: 22222 })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(endpoints.bind(org, 'fleet', { boxIdOrName: 'fleet', port: 65536 })).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('does not bind a box being destroyed', async () => {
    await database.query(`UPDATE "box" SET "desiredState" = 'destroyed'`)
    await expect(bind()).rejects.toMatchObject({ status: 404 })
  })

  it('checks current ownership during a concurrent transfer', async () => {
    const transfer = database.createQueryRunner()
    await transfer.startTransaction()
    try {
      await transfer.query(`UPDATE "box" SET "organizationId" = $1 WHERE "id" = 'AbCdEf123456'`, [otherOrg])
      const pending = bind()
      await transfer.commitTransaction()
      await expect(pending).rejects.toMatchObject({ status: 404 })
    } finally {
      await transfer.release()
    }
  })

  it('rolls the migration down and up', async () => {
    const runner = database.createQueryRunner()
    try {
      await migration.down(runner)
      expect(await runner.query(`SELECT to_regclass('box_endpoint') AS name`)).toEqual([{ name: null }])
      await migration.up(runner)
      await expect(bind()).resolves.toMatchObject({ name: 'fleet' })
    } finally {
      await runner.release()
    }
  })
})
