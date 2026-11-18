/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import express from 'express'
import type { Request } from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { McpDelegation } from '../auth/mcp-delegation'
import { McpCatalog, type McpCatalogSources } from '../mcp/mcp-catalog'
import { McpDispatcher } from '../mcp/mcp-dispatcher'
import { servedOperations } from '../mcp/mcp-routes'
import { McpTools } from '../mcp/mcp-tools'
import { BoxliteConfigController } from './boxlite-config.controller'
import { replayPolicy, RequestReplayPolicy } from './request-replay-policy'

jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(() => ({ upgrade: jest.fn() })) }))

const box = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
const key = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'
const requiredOperations = [
  'createBox',
  'startBox',
  'stopBox',
  'removeBox',
  'startExecution',
  'signalExecution',
  'resizeExecution',
  'killExecution',
  'createVolume',
  'removeVolume',
  'createCheckpoint',
  'removeCheckpoint',
  'createImageAlias',
  'deleteImageAlias',
  'removeImage',
  'createRegistry',
  'removeRegistry',
  'claimDomain',
  'bindDomain',
  'unbindDomain',
  'updateInboundNetwork',
  'updateOutboundNetwork',
  'revokeTunnel',
  'configureSsh',
  'enableSsh',
  'disableSsh',
]

function catalog(served: McpCatalogSources['served'] = () => true) {
  return new McpCatalog({ box, admin: {}, dashboard: {}, delegable: () => true, served })
}

/** The dispatcher must preserve exactly the pre-existing REST inputs when the optional key is absent. */
describe('hosted replay capability discovery and production client requests', () => {
  it('limits the shared OpenAPI capability to hosted implementations and declares each required write header', () => {
    expect(box['x-boxlite-hosted-request-replay']).toMatchObject({
      implementations: ['hosted'],
      lifetime: 'PT24H',
      discovery: 'capabilities.idempotency_operations',
    })
    for (const operationId of requiredOperations) {
      const operation = Object.values(box.paths as Record<string, Record<string, unknown>>)
        .flatMap((item) => Object.values(item))
        .find(
          (value) => value && typeof value === 'object' && 'operationId' in value && value.operationId === operationId,
        ) as {
        parameters?: { $ref?: string }[]
      }
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/idempotencyKey' })
    }
    expect(box.components.parameters.idempotencyKey).toMatchObject({
      in: 'header',
      name: 'Idempotency-Key',
      schema: { type: 'string', format: 'uuid' },
      'x-boxlite-hosted-capability': 'idempotency_operations',
    })
    expect(box.components.parameters.idempotencyKey.schema.default).toBeUndefined()
  })

  it.each(requiredOperations)('%s sends only an explicitly supplied replay header', async (operationId) => {
    const operation = catalog().get(operationId)!
    const seen: { method: string; url: string; body: string; key?: string; contentType?: string }[] = []
    const app = express()
    app.use(express.raw({ type: () => true }))
    app.use((req, res) => {
      seen.push({
        method: req.method,
        url: req.originalUrl,
        body: Buffer.isBuffer(req.body) ? req.body.toString() : '',
        key: req.headers['idempotency-key'] as string | undefined,
        contentType: req.headers['content-type'],
      })
      res.status(201).json({ execution_id: 'execution-original' })
    })
    const dispatcher = new McpDispatcher(
      { httpAdapter: { getInstance: () => app } } as never,
      new McpDelegation(),
      {} as never,
    )
    const args: Record<string, unknown> = {}
    for (const param of operation.params) {
      if (param.in === 'path') args[param.name] = `${param.name}/target`
      if (param.in === 'query') args[param.name] = param.name === 'port' ? 3000 : false
    }
    if (operation.body?.kind === 'json') args.body = { enabled: false, count: 0, value: null, nested: { x: 1 } }
    const request = { headers: {}, user: { organizationId: 'org', userId: 'user' } } as unknown as Request
    try {
      await dispatcher.call(operation, args, request)
      await dispatcher.call(operation, { ...args, 'Idempotency-Key': key }, request)
      expect(seen).toHaveLength(2)
      expect(seen[0].key).toBeUndefined()
      expect(seen[1]).toEqual({ ...seen[0], key })
      expect(seen[0].method).toBe(operation.method.toUpperCase())
      const expectedPath = operation.params
        .filter((param) => param.in === 'path')
        .reduce(
          (path, param) => path.replace(`{${param.name}}`, encodeURIComponent(String(args[param.name]))),
          operation.path,
        )
      const expectedQuery = new URLSearchParams()
      for (const param of operation.params.filter((param) => param.in === 'query')) {
        expectedQuery.append(param.name, String(args[param.name]))
      }
      expect(seen[0].url).toBe(expectedPath + (expectedQuery.size ? `?${expectedQuery}` : ''))
      expect(seen[0].body).toBe(operation.body ? JSON.stringify(args.body) : '')
      expect(seen[0].contentType).toBe(operation.body ? 'application/json' : undefined)
    } finally {
      await dispatcher.onModuleDestroy()
    }
  })

  it('derives config and MCP discovery from registered hosted routes, excluding unserved operations', () => {
    const app = express()
    const all = catalog()
    for (const operationId of requiredOperations) {
      const op = all.get(operationId)!
      app[op.method as 'post'](op.path.replace(/\{([^}]+)\}/g, ':$1'), (_req, res) => res.end())
    }
    const policy = new RequestReplayPolicy()
    policy.configure(app, box)
    const config = new BoxliteConfigController(undefined, policy).getConfig().capabilities
    expect(config.idempotency_key_lifetime).toBe('PT24H')
    expect(config.idempotency_operations.sort()).toEqual([...requiredOperations].sort())
    const served = servedOperations(app as never, () => false)
    const actual = catalog(served)
    expect(
      actual
        .all()
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(config.idempotency_operations)
    for (const op of actual.all()) {
      expect(op.inputSchema).toMatchObject({ properties: { 'Idempotency-Key': { type: 'string', format: 'uuid' } } })
      expect(replayPolicy(op.method, op.path, op.webSocket)).toBe('supported')
    }
    expect(actual.get('createSnapshot')).toBeUndefined()
  })

  it.each(['getBox', 'listBoxes', 'uploadFiles', 'downloadFiles', 'prepareTunnel', 'attachBox', 'attachExecution'])(
    '%s does not advertise hosted replay',
    (operationId) => {
      const op = catalog().get(operationId)!
      expect((op.inputSchema.properties as Record<string, unknown>)['Idempotency-Key']).toBeUndefined()
      expect(op.params.some((param) => param.name === 'Idempotency-Key')).toBe(false)
    },
  )

  it('preserves the independent invitation idempotency header', async () => {
    const admin = parse(readFileSync(resolve(__dirname, '../../../../openapi/admin.openapi.yaml'), 'utf8'))
    const operations = new McpCatalog({ box, admin, dashboard: {}, delegable: () => true, served: () => true })
    const operation = operations.get('createInvite')!
    expect(operation.params).toContainEqual({ name: 'Idempotency-Key', in: 'header', required: false })
    const app = express()
    const seen: (string | undefined)[] = []
    app.use(express.json())
    app.use((req, res) => {
      seen.push(req.headers['idempotency-key'] as string | undefined)
      res.status(201).json({ id: 'invitation' })
    })
    const dispatcher = new McpDispatcher(
      { httpAdapter: { getInstance: () => app } } as never,
      new McpDelegation(),
      {} as never,
    )
    const args = Object.fromEntries(
      operation.params.filter((param) => param.in === 'path').map((param) => [param.name, 'org']),
    )
    const request = { headers: {}, user: { organizationId: 'org', userId: 'user' } } as unknown as Request
    try {
      await dispatcher.call(operation, { ...args, body: { email: 'invite@example.test' } }, request)
      await dispatcher.call(
        operation,
        { ...args, body: { email: 'invite@example.test' }, 'Idempotency-Key': key },
        request,
      )
      expect(seen).toEqual([undefined, key])
    } finally {
      await dispatcher.onModuleDestroy()
    }
  })
})

describe('MCP replay business input', () => {
  it('strips both wait controls before the production REST dispatcher constructs its request', async () => {
    const app = express()
    const seen: { body: unknown; key?: string; query: unknown }[] = []
    app.use(express.json())
    app.post('/api/v1/boxes/:box_id/exec', (req, res) => {
      seen.push({ body: req.body, key: req.headers['idempotency-key'] as string | undefined, query: req.query })
      res.status(201).json({ execution_id: 'original-execution' })
    })
    const dispatcher = new McpDispatcher(
      { httpAdapter: { getInstance: () => app } } as never,
      new McpDelegation(),
      {} as never,
    )
    type Tool = { name: string; handler: (args: object, context: unknown, request: Request) => Promise<unknown> }
    const registered: Tool[] = []
    const tools = new McpTools(
      { registerTool: (tool: Tool) => registered.push(tool) } as never,
      dispatcher,
      { getControllers: () => [] } as unknown as DiscoveryService,
      new MetadataScanner(),
      new Reflector(),
    )
    tools.register({ box, admin: {}, dashboard: {}, served: () => true })
    const invoke = registered.find((tool) => tool.name === 'startExecution')!
    const request = { headers: {}, user: { organizationId: 'org', userId: 'user' } } as unknown as Request
    const args = { box_id: 'box', body: { cmd: ['echo', 'hello'] }, 'Idempotency-Key': key, wait: false }
    try {
      await invoke.handler({ ...args, wait_timeout_seconds: 1 }, undefined, request)
      await invoke.handler({ ...args, wait_timeout_seconds: 90 }, undefined, request)
      expect(seen).toEqual([
        { body: args.body, key, query: {} },
        { body: args.body, key, query: {} },
      ])
    } finally {
      await dispatcher.onModuleDestroy()
    }
  })
})
