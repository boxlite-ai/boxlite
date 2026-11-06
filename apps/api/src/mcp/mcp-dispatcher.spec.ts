/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import express from 'express'
import type { Request } from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import passport from 'passport'
import { parse } from 'yaml'
import { MCP_DELEGATION_STRATEGY, McpDelegation } from '../auth/mcp-delegation'
import { McpCatalog, type McpOperation } from './mcp-catalog'
import { McpArgumentError, McpDispatcher } from './mcp-dispatcher'

const spec = (name: string) => parse(readFileSync(resolve(__dirname, '../../../../openapi', name), 'utf8'))
const catalog = new McpCatalog({
  box: spec('box.openapi.yaml'),
  admin: spec('admin.openapi.yaml'),
  dashboard: {},
  delegable: () => true,
  served: () => true,
})

/** What the REST route saw on the injected request. */
type Seen = { user: unknown; authorization?: string; ip?: string; params: Record<string, string>; body: unknown }

function setup() {
  const delegation = new McpDelegation()
  const seen: Seen[] = []
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use(passport.initialize())
  // The REST side authenticates with the delegation strategy, as CombinedAuthGuard tries it first.
  app.post(
    '/api/v1/boxes/:box_id/exec',
    passport.authenticate(MCP_DELEGATION_STRATEGY, { session: false }),
    (req, res) => {
      seen.push({
        user: req.user,
        authorization: req.headers.authorization,
        ip: req.ip,
        params: req.params as Record<string, string>,
        body: req.body,
      })
      res.status(201).json({ execution_id: 'exec-1' })
    },
  )
  const dispatcher = new McpDispatcher({ httpAdapter: { getInstance: () => app } } as never, delegation)
  dispatchers.push(dispatcher)
  return { dispatcher, delegation, seen }
}

const dispatchers: McpDispatcher[] = []
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.onModuleDestroy()))
})

function mcpRequest(user: object): Request {
  return {
    user,
    headers: { authorization: 'Bearer mcp-audience-token', 'x-forwarded-for': '203.0.113.7' },
    socket: { remoteAddress: '10.0.0.5' },
  } as unknown as Request
}

describe('McpDispatcher', () => {
  const startExecution = catalog.get('startExecution') as McpOperation

  it('runs the REST route as the MCP caller without forwarding its token', async () => {
    const { dispatcher, seen } = setup()
    const caller = { userId: 'user-1', role: 'user', email: 'u@example.test', organizationId: 'org-1' }

    const response = await dispatcher.call(
      startExecution,
      { box_id: 'my-box', body: { command: 'echo' } },
      mcpRequest(caller),
    )

    expect(response.status).toBe(201)
    expect(response.json).toEqual({ execution_id: 'exec-1' })
    expect(seen).toHaveLength(1)
    expect(seen[0].user).toBe(caller)
    expect(seen[0].authorization).toBeUndefined()
    expect(seen[0].ip).toBe('203.0.113.7')
    expect(seen[0].body).toEqual({ command: 'echo' })
  })

  it('keeps a path argument inside its own segment', async () => {
    const { dispatcher, seen } = setup()

    await dispatcher.call(
      startExecution,
      { box_id: '../../admin/runners', body: { command: 'x' } },
      mcpRequest({ userId: 'u' }),
    )

    expect(seen[0].params.box_id).toBe('../../admin/runners')
  })

  it.each(['..', '.', ''])('refuses the path argument %j', async (boxId) => {
    const { dispatcher, seen } = setup()

    await expect(
      dispatcher.call(startExecution, { box_id: boxId, body: { command: 'x' } }, mcpRequest({ userId: 'u' })),
    ).rejects.toBeInstanceOf(McpArgumentError)
    expect(seen).toHaveLength(0)
  })

  it('admits a delegation nonce once', () => {
    const { delegation } = setup()
    const caller = { userId: 'u', role: 'user', email: 'u@example.test' } as never
    const nonce = delegation.issue(caller)

    expect(delegation.take(nonce)).toBe(caller)
    expect(delegation.take(nonce)).toBeUndefined()
    expect(delegation.take('guessed-nonce')).toBeUndefined()
  })
})
