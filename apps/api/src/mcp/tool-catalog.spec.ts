/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { MODULE_METADATA } from '@nestjs/common/constants'
import type { Provider } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { parse } from 'yaml'
import { AuditService } from '../audit/services/audit.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { BoxService } from '../box/services/box.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { RunnerService } from '../box/services/runner.service'
import { TunnelService } from '../box/services/tunnel.service'
import { VolumeService } from '../box/services/volume.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { TypedConfigService } from '../config/typed-config.service'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { RegistriesService } from '../registry/services/registries.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { MCP_CALLER_KEY, McpServerFactory } from './mcp-server.factory'
import { McpModule } from './mcp.module'

// This is the selected public contract, rather than a list derived from tool implementation.
const toolByOperation = {
  getConfig: 'get_config',
  createVolume: 'create_volume',
  listVolumes: 'list_volumes',
  getVolume: 'get_volume',
  removeVolume: 'delete_volume',
  createBox: 'create_box',
  listBoxes: 'list_boxes',
  getBox: 'get_box',
  boxExists: 'box_exists',
  removeBox: 'delete_box',
  startBox: 'start_box',
  stopBox: 'stop_box',
  startExecution: 'exec_box',
  getExecution: 'get_execution',
  killExecution: 'kill_execution',
  signalExecution: 'signal_execution',
  resizeExecution: 'resize_execution',
  uploadFiles: 'upload_files',
  downloadFiles: 'download_files',
  prepareTunnel: 'prepare_tunnel',
  updateInboundNetwork: 'set_box_inbound',
  getBoxMetrics: 'get_box_metrics',
  listImages: 'list_images',
  getImageUsage: 'get_image_usage',
  getImage: 'get_image',
  removeImage: 'delete_image',
  createImageAlias: 'create_image_alias',
  deleteImageAlias: 'delete_image_alias',
  listRegistries: 'list_registries',
  createRegistry: 'create_registry',
  removeRegistry: 'delete_registry',
}

const excludedOperations = new Set([
  // New REST operations do not expand the selected MCP MVP during a main merge.
  'configureSsh',
  'getSshStatus',
  'disableSsh',
  'revokeTunnel',
  'updateOutboundNetwork',
  'getCurrentPrincipal',
  'createSnapshot',
  'listSnapshots',
  'getSnapshot',
  'removeSnapshot',
  'restoreSnapshot',
  'cloneBox',
  'exportBox',
  'importBox',
  'getRuntimeMetrics',
  'attachBox',
  'attachExecution',
])

describe('Mcp assembled tool catalog', () => {
  let moduleRef: TestingModule
  let handler: McpHttpHandler
  let server: Server
  let url: string

  beforeAll(async () => {
    // Instantiate the real provider declarations and registrations, without opening service connections.
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, McpModule) as Provider[]
    moduleRef = await Test.createTestingModule({
      providers: [
        ...providers,
        ...[
          AuditService,
          BoxService,
          BoxAutoResumeService,
          BoxStateWaiterService,
          CommerceBoxLimitService,
          ImageCatalogService,
          OrganizationService,
          OrganizationUserService,
          RegistriesService,
          RunnerService,
          TunnelService,
          VolumeService,
        ].map((provide) => ({ provide, useValue: {} })),
        { provide: JwtStrategy, useValue: { issuer: 'https://issuer.test/' } },
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => (key === 'mcp.resourceUrl' ? 'https://boxlite.test/api/mcp' : undefined) },
        },
      ],
    }).compile()
    handler = createMcpHandler(moduleRef.get(McpServerFactory).forRequest, { legacy: 'reject', responseMode: 'json' })
    const serve = toNodeHandler(handler)
    server = createServer((request, response) => {
      Object.assign(request, {
        auth: {
          token: 'catalog-test-token',
          clientId: 'catalog-test',
          scopes: [],
          extra: {
            [MCP_CALLER_KEY]: { userId: 'catalog-user', email: 'catalog@example.test', role: SystemRole.USER },
          },
        },
      })
      void serve(request, response)
    })
    await new Promise<void>((complete) => server.listen(0, '127.0.0.1', complete))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`
  })

  afterAll(async () => {
    await handler?.close()
    if (server) await new Promise<void>((complete) => server.close(() => complete()))
    await moduleRef?.close()
  })

  it('registers exactly the implemented OpenAPI operations with typed, explicit contracts', async () => {
    const document = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
    const operations = Object.values(document.paths as Record<string, Record<string, { operationId?: string }>>)
      .flatMap((path) => Object.values(path))
      .flatMap((operation) => (operation?.operationId ? [operation.operationId] : []))
    expect(operations.filter((operation) => !excludedOperations.has(operation)).sort()).toEqual(
      Object.keys(toolByOperation).sort(),
    )
    expect(operations.filter((operation) => excludedOperations.has(operation)).sort()).toEqual(
      [...excludedOperations].sort(),
    )

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'catalog-test', version: '0' },
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    const tools = body.result.tools
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(toolByOperation).sort())
    for (const tool of tools) {
      expect(tool.inputSchema).toEqual(expect.objectContaining({ type: 'object', additionalProperties: false }))
      expect(tool.outputSchema).toBeDefined()
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof tool.annotations[hint]).toBe('boolean')
      }
      if (tool.name !== 'get_config') expect(tool.inputSchema.required).toContain('organization_id')
    }
    expect(tools.find((tool: { name: string }) => tool.name === 'list_boxes').annotations.destructiveHint).toBe(false)
    expect(tools.find((tool: { name: string }) => tool.name === 'exec_box').annotations.openWorldHint).toBe(true)
  })
})
