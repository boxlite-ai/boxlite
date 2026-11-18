/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import express from 'express'
import type { Request } from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { McpDelegation } from '../auth/mcp-delegation'
import { McpCatalog } from '../mcp/mcp-catalog'
import { McpDispatcher } from '../mcp/mcp-dispatcher'
import { servedOperations } from '../mcp/mcp-routes'
import { BoxliteConfigController } from './boxlite-config.controller'
import { replayPolicy, RequestReplayPolicy } from './request-replay-policy'

jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(() => ({ upgrade: jest.fn() })) }))

const box = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
const admin = parse(readFileSync(resolve(__dirname, '../../../../openapi/admin.openapi.yaml'), 'utf8'))
const catalog = new McpCatalog({ box, admin, dashboard: {}, delegable: () => true, served: () => true })
const key = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'

describe('hosted replay discovery and production requests', () => {
  it.each(['startExecution', 'createInvite'])(
    '%s preserves inputs with and without the optional header',
    async (id) => {
      const operation = catalog.get(id)!
      expect(operation.params).toContainEqual({ name: 'Idempotency-Key', in: 'header', required: false })
      const seen: { method: string; url: string; body: unknown; key?: string }[] = []
      const app = express()
      app.use(express.json())
      app.use((req, res) => {
        seen.push({
          method: req.method,
          url: req.originalUrl,
          body: req.body,
          key: req.headers['idempotency-key'] as string,
        })
        res.status(201).json({ id: 'original-result' })
      })
      const dispatcher = new McpDispatcher(
        { httpAdapter: { getInstance: () => app } } as never,
        new McpDelegation(),
        {} as never,
      )
      const args = Object.fromEntries(
        operation.params.filter((param) => param.in === 'path').map((param) => [param.name, 'org/target']),
      )
      const body = id === 'startExecution' ? { cmd: ['echo', 'hello'] } : { email: 'invite@example.test' }
      const request = { headers: {}, user: { organizationId: 'org', userId: 'user' } } as unknown as Request
      try {
        await dispatcher.call(operation, { ...args, body }, request)
        await dispatcher.call(operation, { ...args, body, 'Idempotency-Key': key }, request)
        expect(seen).toHaveLength(2)
        expect(seen[0]).toEqual({
          method: operation.method.toUpperCase(),
          url: operation.path.replace(/\{[^}]+\}/g, 'org%2Ftarget'),
          body,
          key: undefined,
        })
        expect(seen[1]).toEqual({ ...seen[0], key })
      } finally {
        await dispatcher.onModuleDestroy()
      }
    },
  )

  it('advertises exactly registered replay writes in config and MCP', () => {
    const app = express()
    const registeredIds = [
      'bindDomain',
      'claimDomain',
      'configureSsh',
      'createBox',
      'createCheckpoint',
      'createImageAlias',
      'createRegistry',
      'createVolume',
      'deleteImageAlias',
      'disableSsh',
      'enableSsh',
      'killExecution',
      'removeBox',
      'removeCheckpoint',
      'removeImage',
      'removeRegistry',
      'removeVolume',
      'resizeExecution',
      'revokeTunnel',
      'signalExecution',
      'startBox',
      'startExecution',
      'stopBox',
      'unbindDomain',
      'updateInboundNetwork',
      'updateOutboundNetwork',
    ]
    const operations = registeredIds.map((id) => catalog.get(id)!)
    expect(operations.every((op) => replayPolicy(op.method, op.path, op.webSocket) === 'supported')).toBe(true)
    expect(box['x-boxlite-hosted-request-replay']).toMatchObject({
      implementations: ['hosted'],
      lifetime: 'PT24H',
      discovery: 'capabilities.idempotency_operations',
    })
    for (const op of operations) {
      app[op.method as 'post'](op.path.replace(/\{([^}]+)\}/g, ':$1'), (_req, res) => res.end())
      expect(op.inputSchema).toMatchObject({ properties: { 'Idempotency-Key': { type: 'string', format: 'uuid' } } })
    }
    const policy = new RequestReplayPolicy()
    policy.configure(app, box)
    const config = new BoxliteConfigController(undefined, policy).getConfig().capabilities
    expect(config.idempotency_key_lifetime).toBe('PT24H')
    expect(config.idempotency_operations.sort()).toEqual(operations.map((op) => op.operationId).sort())
    const served = servedOperations(app as never, () => false)
    const actual = new McpCatalog({ box, admin: {}, dashboard: {}, delegable: () => true, served })
    expect(
      actual
        .all()
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(config.idempotency_operations)
    expect(actual.get('createSnapshot')).toBeUndefined()
    for (const id of ['getBox', 'uploadFiles', 'prepareTunnel', 'attachExecution']) {
      expect(catalog.get(id)!.inputSchema.properties).not.toHaveProperty('Idempotency-Key')
    }
    expect(box.components.parameters.idempotencyKey.schema.default).toBeUndefined()
  })
})
