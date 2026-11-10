/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Post, UseGuards } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { AuthGuard } from '@nestjs/passport'
import { ApiOperation, DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { MCP_STRATEGY } from '@rekog/mcp-nest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../auth/runner-auth.guard'
import { McpDispatcher } from './mcp-dispatcher'
import { servedOperations } from './mcp-routes'
import { McpTools } from './mcp-tools'
import { MCP_OAUTH_OPERATIONS, MCP_OAUTH_SCOPES } from './mcp-oauth-policy'

// `McpDispatcher` routes attach upgrades through `BoxliteWsProxyService`, whose
// proxy dependency ships ESM that Jest does not transform.
jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(() => ({ upgrade: jest.fn() })) }))

@Controller('box')
@UseGuards(CombinedAuthGuard)
class DashboardBoxController {
  @Post(':boxIdOrName/attach-tickets')
  @ApiOperation({ operationId: 'createAttachTicket' })
  createAttachTicket() {}

  @Get(':boxIdOrName')
  @ApiOperation({ operationId: 'getBox' })
  getBox() {}
}

@Controller('jobs')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
class RunnerJobController {
  @Get()
  @ApiOperation({ operationId: 'listJobs' })
  listJobs() {}
}

@Controller('organizations')
class OrganizationController {
  @Get()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ operationId: 'listOrganizations' })
  listOrganizations() {}
}

const spec = (name: string) => parse(readFileSync(resolve(__dirname, '../../../../openapi', name), 'utf8'))

type Tool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> | unknown }

async function registered(served: Parameters<McpTools['register']>[0]['served'] = () => true) {
  const tools: Tool[] = []
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [DashboardBoxController, RunnerJobController, OrganizationController],
    providers: [
      McpTools,
      { provide: MCP_STRATEGY, useValue: { registerTool: (tool: Tool) => tools.push(tool) } },
      { provide: McpDispatcher, useValue: {} },
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()
  const dashboard = SwaggerModule.createDocument(app, new DocumentBuilder().build())
  const catalog = moduleRef
    .get(McpTools)
    .register({ box: spec('box.openapi.yaml'), admin: spec('admin.openapi.yaml'), dashboard, served })
  await app.close()
  return { tools, catalog }
}

describe('McpTools.register', () => {
  it('lists the direct box tools and the three meta-tools, not one tool per operation', async () => {
    const { tools, catalog } = await registered()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'createBox',
        'downloadFiles',
        'getBox',
        'getExecution',
        'get_api_endpoint_schema',
        'invoke_api_endpoint',
        'listBoxes',
        'list_api_endpoints',
        'removeBox',
        'startBox',
        'startExecution',
        'stopBox',
        'uploadFiles',
      ].sort(),
    )
    expect(catalog.all().length).toBeGreaterThan(tools.length)
  })

  it('reaches delegable dashboard routes and leaves runner and JWT-only routes out', async () => {
    const { tools } = await registered()
    const list = tools.find((tool) => tool.name === 'list_api_endpoints') as Tool

    const result = (await list.handler({})) as {
      structuredContent: { endpoints: { operationId: string; path: string }[] }
    }
    const ids = result.structuredContent.endpoints.map((endpoint) => endpoint.operationId)

    expect(result.structuredContent.endpoints).toContainEqual(
      expect.objectContaining({ operationId: 'createAttachTicket', path: '/api/box/{boxIdOrName}/attach-tickets' }),
    )
    expect(ids).not.toContain('listJobs')
    expect(ids).not.toContain('listOrganizations')
  })

  it('keeps the v1 route when the dashboard reuses an operationId', async () => {
    const { catalog } = await registered()

    expect(catalog.get('getBox')).toMatchObject({ method: 'get', path: '/api/v1/boxes/{box_id}' })
  })

  it('maps tar and WebSocket operations to base64 bodies and the attach collector', async () => {
    const { catalog } = await registered()

    expect(catalog.get('uploadFiles')?.body).toMatchObject({ kind: 'binary', contentType: 'application/x-tar' })
    expect(catalog.get('uploadFiles')?.inputSchema).toMatchObject({
      properties: expect.objectContaining({ body_base64: expect.any(Object) }),
    })
    expect(catalog.get('attachExecution')?.webSocket).toBe(true)
    expect(catalog.get('startExecution')?.path).toBe('/api/v1/boxes/{box_id}/exec')
  })

  it('leaves out spec operations the served predicate rejects', async () => {
    const { catalog } = await registered((op) => !op.path.includes('/volumes'))

    expect(catalog.get('getBox')).toBeDefined()
    expect(catalog.get('listVolumes')).toBeUndefined()
  })
})

/**
 * Every v1 operation an OAuth token may not run. Together with `MCP_OAUTH_OPERATIONS`
 * this classifies the whole v1 surface, so a new spec operation fails here until
 * someone decides whether OAuth callers may reach it.
 */
const API_KEY_ONLY = [
  'enableSsh',
  'configureSsh',
  'exportBox',
  'importBox',
  'createCheckpoint',
  'listCheckpoints',
  'getCheckpoint',
  'removeCheckpoint',
  'attachBox',
  'prepareTunnel',
  'revokeTunnel',
  'updateInboundNetwork',
  'updateOutboundNetwork',
  'listDomains',
  'claimDomain',
  'bindDomain',
  'unbindDomain',
  'listRegistries',
  'createRegistry',
  'removeRegistry',
  'listUsers',
  'removeUser',
  'listInvites',
  'createInvite',
  'cancelInvite',
]

describe('MCP OAuth allowlist', () => {
  it('classifies every v1 operation as OAuth-allowed or API-key only', () => {
    const ids = ['box.openapi.yaml', 'admin.openapi.yaml'].flatMap((name) =>
      Object.values(spec(name).paths as Record<string, Record<string, { operationId?: string }>>).flatMap((item) =>
        Object.values(item).flatMap((op) => (op?.operationId ? [op.operationId] : [])),
      ),
    )
    const unclassified = ids.filter((id) => !MCP_OAUTH_OPERATIONS.has(id) && !API_KEY_ONLY.includes(id))
    const both = API_KEY_ONLY.filter((id) => MCP_OAUTH_OPERATIONS.has(id))

    expect({ unclassified, both }).toEqual({ unclassified: [], both: [] })
  })

  it('grants MCP clients exactly the scopes the Auth0 reconciler defines', () => {
    const reconciler = JSON.parse(
      readFileSync(resolve(__dirname, '../../../infra/bootstrap/auth0/mcp-clients.json'), 'utf8'),
    ) as { scopes: string[] }

    expect([...MCP_OAUTH_SCOPES].sort()).toEqual([...reconciler.scopes].sort())
  })
})

describe('servedOperations', () => {
  it('matches spec paths against the routes Express registered', async () => {
    const express = (await import('express')).default
    const app = express()
    app.get('/api/v1/boxes/:boxId', () => undefined)
    app.all('/api/v1/boxes/:boxId/files', () => undefined)
    const served = servedOperations(app as never, (path) => path === '/api/v1/boxes/x/executions/x/attach')

    expect(served({ method: 'get', path: '/api/v1/boxes/{box_id}', webSocket: false })).toBe(true)
    expect(served({ method: 'put', path: '/api/v1/boxes/{box_id}/files', webSocket: false })).toBe(true)
    expect(served({ method: 'delete', path: '/api/v1/boxes/{box_id}', webSocket: false })).toBe(false)
    expect(served({ method: 'post', path: '/api/v1/boxes/{box_id}/snapshots', webSocket: false })).toBe(false)
    expect(served({ method: 'get', path: '/api/v1/boxes/{box_id}/executions/{exec_id}/attach', webSocket: true })).toBe(
      true,
    )
    expect(served({ method: 'get', path: '/api/v1/boxes/{box_id}/attach', webSocket: true })).toBe(false)
  })
})
