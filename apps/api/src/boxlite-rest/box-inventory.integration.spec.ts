/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Test } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import { HttpAdapterHost, Reflector } from '@nestjs/core'
import { DataSource, Repository } from 'typeorm'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { Box } from '../box/entities/box.entity'
import { BoxLastActivity } from '../box/entities/box-last-activity.entity'
import { BoxMigration } from '../box/entities/box-migration.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxDto } from '../box/dto/box.dto'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { McpDelegation } from '../auth/mcp-delegation'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { McpCatalog } from '../mcp/mcp-catalog'
import { McpDispatcher } from '../mcp/mcp-dispatcher'
import { BoxliteBoxController } from './boxlite-box.controller'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { boxToBoxResponse } from './mappers/box-to-box.mapper'

jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn() }))
const org = '00000000-0000-4000-8000-000000000001'
const otherOrg = '00000000-0000-4000-8000-000000000002'
const schema = `inventory_${randomUUID().replaceAll('-', '')}`
const describeDatabase = process.env.DB_HOST ? describe : describe.skip

describeDatabase('Box inventory real PostgreSQL and HTTP', () => {
  let db: DataSource
  let rows: Repository<Box>
  let app: INestApplication
  let base: string
  let dispatcher: McpDispatcher
  const caller = { organizationId: org, organization: { id: org } }
  const catalog = new McpCatalog({
    box: parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8')),
    admin: {},
    dashboard: {},
    delegable: () => true,
    served: () => true,
  })

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Box, BoxLastActivity, BoxMigration],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    rows = db.getRepository(Box)
    const repository = new BoxRepository(db, { emit: jest.fn() } as any, {} as any)
    const service = Object.assign(Object.create(BoxService.prototype), {
      boxRepository: repository,
      boxActivityService: { getLastActivityAtMany: async () => new Map() },
      imagePreparationService: { preparingImage: async () => new Set() },
    })
    const module = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        { provide: BoxService, useValue: service },
        { provide: BoxStateWaiterService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: {} },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: any) {
          const request = context.switchToHttp().getRequest()
          request.user = request.headers['x-test-unscoped-admin']
            ? { role: 'admin' }
            : request.headers['x-test-other-org']
              ? { organizationId: otherOrg, organization: { id: otherOrg } }
              : caller
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({
        async canActivate(context: any) {
          const request = context.switchToHttp().getRequest()
          if (!request.headers['x-test-real-admin-guard']) return true
          request.user = { ...caller, role: 'admin' }
          const guard = new OrganizationResourceActionGuard(
            { findOne: async () => null } as any,
            {} as any,
            new Reflector(),
          )
          Object.assign(guard, { redis: { get: async () => null } })
          return guard.canActivate(context)
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
    dispatcher = new McpDispatcher(app.get(HttpAdapterHost), new McpDelegation(), {} as any)
  })
  afterAll(async () => {
    await dispatcher?.onModuleDestroy()
    await app?.close()
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await rows.createQueryBuilder().delete().execute()
    for (let i = 1; i <= 7; i++) {
      const box = new Box('us', `box-${i}`)
      box.id = String(i).padStart(12, '0')
      box.organizationId = i === 7 ? otherOrg : org
      box.osUser = 'root'
      box.state = i % 2 ? BoxState.STARTED : BoxState.STOPPED
      box.desiredState = i % 2 ? BoxDesiredState.STARTED : BoxDesiredState.STOPPED
      await rows.save(box)
    }
  })
  async function get(query: string, prefix = '', headers = {}) {
    const response = await fetch(`${base}/api/v1/${prefix}boxes?${query}`, { headers })
    return { status: response.status, body: await response.json() }
  }
  async function tool(args: Record<string, unknown>) {
    return dispatcher.call(catalog.get('listBoxes')!, args, {
      headers: {},
      user: caller,
      socket: new EventEmitter(),
    } as any)
  }

  it('bounds REST pages and continues matching status before the limit', async () => {
    const first = await get('status=stopped&pageSize=2')
    expect(first.status).toBe(200)
    expect(first.body.boxes.map((b: any) => b.box_id)).toEqual(['000000000002', '000000000004'])
    expect(first.body.boxes.every((b: any) => b.status === 'stopped')).toBe(true)
    expect(first.body.next_page_token).toEqual(expect.any(String))
    await rows.delete('000000000004')
    const next = await get(`status=stopped&pageSize=1&pageToken=${first.body.next_page_token}`, `${org}/`)
    expect(next.body.boxes.map((b: any) => b.box_id)).toEqual(['000000000006'])
    expect(next.body).not.toHaveProperty('next_page_token')
  })
  it('requires a resolved organization even for an admin admitted by the resource guard', async () => {
    const result = await get('pageSize=2', '', { 'x-test-unscoped-admin': 'true' })
    expect(result.status).toBe(400)
    expect(result.body).not.toHaveProperty('boxes')
  })
  it('rejects an unresolved prefix even when real guards retain an admin organization', async () => {
    const result = await get('pageSize=2', 'missing/', { 'x-test-real-admin-guard': 'true' })
    expect(result.status).toBe(400)
    expect(result.body).not.toHaveProperty('boxes')
  })
  it('bounds unfiltered REST inventory', async () => {
    const result = await get('pageSize=2')
    expect(result.body.boxes).toHaveLength(2)
    expect(result.body.next_page_token).toEqual(expect.any(String))
  })
  it('uses the same filtered continuation through MCP dispatch', async () => {
    const first = await tool({ status: 'stopped', pageSize: 2 })
    const body = first.json as any
    expect(first.status).toBe(200)
    expect(body.boxes.map((b: any) => b.box_id)).toEqual(['000000000002', '000000000004'])
    const next = await tool({ status: 'stopped', pageSize: 2, pageToken: body.next_page_token })
    expect((next.json as any).boxes.map((b: any) => b.box_id)).toEqual(['000000000006'])
  })

  it.each(['running', 'stopped', 'configured', 'stopping', 'unknown', 'paused', 'failed'])(
    'matches production response projection for all persisted combinations: %s',
    async (status) => {
      await rows.createQueryBuilder().delete().execute()
      let id = 0
      for (const state of Object.values(BoxState))
        for (const desiredState of Object.values(BoxDesiredState)) {
          const box = new Box('us', `combination-${++id}`)
          Object.assign(box, {
            id: String(id).padStart(12, '0'),
            organizationId: org,
            osUser: 'root',
            state,
            desiredState,
          })
          await rows.save(box)
        }
      const visible = (await rows.find()).filter(
        (b) =>
          b.state !== BoxState.DESTROYED &&
          !(b.state === BoxState.ERROR && b.desiredState === BoxDesiredState.DESTROYED),
      )
      const expected = visible
        .filter((b) => boxToBoxResponse(BoxDto.fromBox(b)).status === status)
        .map((b) => b.id)
        .sort()
      const result = await get(`status=${status}&pageSize=1000`)
      expect(result.status).toBe(200)
      expect(result.body.boxes.map((b: any) => b.box_id)).toEqual(expected)
    },
  )
  it.each([
    'pageSize=0',
    'pageSize=1001',
    'pageSize=-1',
    'pageSize=1.5',
    'pageSize=',
    'pageSize=oops',
    'pageSize=1&pageSize=2',
    'status=oops',
    'status=',
    'status=stopped&status=running',
    'pageToken=',
    'pageToken=%%%',
    'pageToken=e30',
    'pageToken=a&pageToken=b',
  ])('rejects invalid input %s', async (query) => expect((await get(query)).status).toBe(400))
  it('uses the default page size and permits boundary sizes', async () => {
    await rows.createQueryBuilder().delete().execute()
    const boxes = Array.from({ length: 101 }, (_, i) =>
      Object.assign(new Box('us', `default-${i}`), {
        id: String(i + 1).padStart(12, '0'),
        organizationId: org,
        osUser: 'root',
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STOPPED,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    )
    await rows.save(boxes)
    const first = await get('')
    expect(first.body.boxes).toHaveLength(100)
    expect(first.body.next_page_token).toEqual(expect.any(String))
    expect((await get(`pageSize=1&pageToken=${first.body.next_page_token}`)).body.boxes).toHaveLength(1)
    const all = await get('pageSize=1000')
    expect(all.body.boxes).toHaveLength(101)
    expect(all.body).not.toHaveProperty('next_page_token')
    expect((await get(`pageToken=${'a'.repeat(2049)}`)).status).toBe(400)
    await rows.createQueryBuilder().delete().execute()
    expect((await get('')).body).toEqual({ boxes: [] })
  })
  it('rejects null and unrecognized persisted lifecycle states', async () => {
    for (const column of ['state', 'desiredState']) {
      await expect(
        db.query(`UPDATE "${schema}".box SET "${column}" = NULL WHERE id = $1`, ['000000000001']),
      ).rejects.toMatchObject({ code: '23502' })
      await expect(
        db.query(`UPDATE "${schema}".box SET "${column}" = 'not-a-state' WHERE id = $1`, ['000000000001']),
      ).rejects.toMatchObject({ code: '22P02' })
    }
  })
  it('rejects cursor scope changes and malformed structured tokens', async () => {
    const first = await get('status=stopped&pageSize=1')
    const token = first.body.next_page_token
    expect((await get(`status=running&pageToken=${token}`)).status).toBe(400)
    expect((await get(`status=stopped&pageToken=${token}`, '', { 'x-test-other-org': '1' })).status).toBe(400)
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString())
    for (const changed of [
      [9, ...decoded.slice(1)],
      [1, 'users', ...decoded.slice(2)],
      [...decoded.slice(0, -1), 'invalid-id'],
    ]) {
      expect(
        (await get(`status=stopped&pageToken=${Buffer.from(JSON.stringify(changed)).toString('base64url')}`)).status,
      ).toBe(400)
    }
  })
})
