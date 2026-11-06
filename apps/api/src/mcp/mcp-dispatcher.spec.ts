/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import express from 'express'
import type { Request } from 'express'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import passport from 'passport'
import { parse } from 'yaml'
import { MCP_DELEGATION_STRATEGY, McpDelegation } from '../auth/mcp-delegation'
import { McpCatalog, type McpOperation } from './mcp-catalog'
import { McpArgumentError, McpDispatcher, McpResponseError, MCP_MAX_BINARY_BYTES } from './mcp-dispatcher'

// `McpDispatcher` routes attach upgrades through `BoxliteWsProxyService`, whose
// proxy dependency ships ESM that Jest does not transform.
jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(() => ({ upgrade: jest.fn() })) }))

const spec = (name: string) => parse(readFileSync(resolve(__dirname, '../../../../openapi', name), 'utf8'))
const catalog = new McpCatalog({
  box: spec('box.openapi.yaml'),
  admin: spec('admin.openapi.yaml'),
  dashboard: {},
  delegable: () => true,
  served: () => true,
})

/** A dashboard listing whose `states` query parameter is an array, as `listBoxesPaginated` declares it. */
const listing = new McpCatalog({
  box: spec('box.openapi.yaml'),
  admin: spec('admin.openapi.yaml'),
  dashboard: {
    paths: {
      '/api/box/paginated': {
        get: {
          operationId: 'listBoxesPaginated',
          parameters: [{ name: 'states', in: 'query', schema: { type: 'array', items: { type: 'string' } } }],
        },
      },
    },
  },
  delegable: () => true,
  served: () => true,
}).get('listBoxesPaginated') as McpOperation

/** What the REST route saw on the injected request. */
type Seen = {
  user: unknown
  authorization?: string
  ip?: string
  params: Record<string, string>
  body: unknown
  query?: unknown
  closed?: Promise<void>
}

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
      const closed = new Promise<void>((resolve) => res.once('close', () => resolve()))
      seen.push({
        user: req.user,
        authorization: req.headers.authorization,
        ip: req.ip,
        params: req.params as Record<string, string>,
        body: req.body,
        closed,
      })
      // Box ids pick a route behavior: never answer, answer slowly, or answer too much.
      if (req.params.box_id === 'stalled') return
      if (req.params.box_id === 'slow') {
        res.status(200).type('application/octet-stream')
        let sent = 0
        const drip = setInterval(() => {
          res.write(Buffer.alloc(1024, 1))
          if (++sent === 5) {
            clearInterval(drip)
            res.end()
          }
        }, 40)
        return
      }
      if (req.params.box_id === 'huge') {
        res
          .status(200)
          .type('application/octet-stream')
          .end(Buffer.alloc(MCP_MAX_BINARY_BYTES + 1))
        return
      }
      res.status(201).json({ execution_id: 'exec-1' })
    },
  )
  app.get('/api/box/paginated', passport.authenticate(MCP_DELEGATION_STRATEGY, { session: false }), (req, res) => {
    seen.push({ user: req.user, params: {}, body: undefined, query: req.query })
    res.json({ items: [] })
  })
  const dispatcher = new McpDispatcher({ httpAdapter: { getInstance: () => app } } as never, delegation, {
    matchAttachPath: () => null,
  } as never)
  dispatchers.push(dispatcher)
  return { dispatcher, delegation, seen }
}

const dispatchers: McpDispatcher[] = []
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.onModuleDestroy()))
})

/** The MCP request a tool call came in on; its socket closes when the MCP client goes away. */
function mcpRequest(user: object): Request {
  const socket = Object.assign(new EventEmitter(), { remoteAddress: '10.0.0.5', destroyed: false })
  return {
    user,
    headers: { authorization: 'Bearer mcp-audience-token', 'x-forwarded-for': '203.0.113.7' },
    socket,
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

  it('sends an array query argument as one key per item', async () => {
    const { dispatcher, seen } = setup()

    await dispatcher.call(listing, { states: ['started', 'stopped'] }, mcpRequest({ userId: 'u' }))

    expect(seen[0].query).toEqual({ states: ['started', 'stopped'] })
  })

  it('stops reading a response past the binary limit', async () => {
    const { dispatcher } = setup()

    await expect(
      dispatcher.call(startExecution, { box_id: 'huge', body: { command: 'x' } }, mcpRequest({ userId: 'u' })),
    ).rejects.toBeInstanceOf(McpResponseError)
  })

  it('gives up on a route that sends nothing for the idle limit', async () => {
    const { dispatcher, seen } = setup()
    Object.assign(dispatcher, { idleTimeoutMs: 100 })

    await expect(
      dispatcher.call(startExecution, { box_id: 'stalled', body: { command: 'x' } }, mcpRequest({ userId: 'u' })),
    ).rejects.toBeInstanceOf(McpResponseError)
    await seen[0].closed
  })

  it('keeps reading a slow route that keeps sending data', async () => {
    const { dispatcher } = setup()
    Object.assign(dispatcher, { idleTimeoutMs: 100 })

    const response = await dispatcher.call(
      startExecution,
      { box_id: 'slow', body: { command: 'x' } },
      mcpRequest({ userId: 'u' }),
    )

    expect(response.status).toBe(200)
    expect(response.body.length).toBe(5 * 1024)
  })

  it('abandons the route when the MCP client disconnects', async () => {
    const { dispatcher, seen } = setup()
    const request = mcpRequest({ userId: 'u' })

    const pending = dispatcher.call(startExecution, { box_id: 'stalled', body: { command: 'x' } }, request)
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    request.socket.emit('close')

    await expect(pending).rejects.toBeInstanceOf(McpResponseError)
    await seen[0].closed
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
