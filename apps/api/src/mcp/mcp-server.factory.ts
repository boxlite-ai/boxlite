/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server'
import { BoxService } from '../box/services/box.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { boxToBoxResponse } from '../boxlite-rest/mappers/box-to-box.mapper'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { listBoxesInputSchema, listBoxesOutputSchema } from './tools/box/box.schema'
import { VolumeTools } from './tools/volume/volume-tools'
import { ImageTools } from './tools/image/image-tools'
import { RegistryTools } from './tools/registry/registry-tools'
import { BoxTools } from './tools/box/box-tools'
import { NetworkTools } from './tools/box/network-tools'
import { registerConfigTool } from './tools/config/config-tool'
import { McpExecutionTools } from './tools/execution/execution-tools'
import { McpFileTools } from './tools/files/file-tools'
import { McpMetricsTools } from './tools/metrics/metrics-tools'

/** The `authInfo.extra` key the controller stores the authenticated caller under. */
export const MCP_CALLER_KEY = 'boxliteCaller'

// One reply for an organization that does not exist and one the caller is not
// in, so the tool cannot be used to probe which organization IDs exist.
const ORGANIZATION_DENIED = 'Organization not found or not accessible'

/**
 * Builds the MCP server for one request.
 *
 * The 2026-07-28 revision is stateless, so `createMcpHandler` asks for a fresh
 * server per request; the caller the controller authenticated arrives in
 * `authInfo.extra` and is bound into the tool handlers here. Organization
 * membership is checked per call: the organization arrives as a tool argument,
 * which the route guards never see.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly boxService: BoxService,
    private readonly organizationUserService: OrganizationUserService,
    private readonly volumeTools: VolumeTools,
    private readonly imageTools: ImageTools,
    private readonly registryTools: RegistryTools,
    private readonly boxTools: BoxTools,
    private readonly networkTools: NetworkTools,
    private readonly executionTools: McpExecutionTools,
    private readonly fileTools: McpFileTools,
    private readonly metricsTools: McpMetricsTools,
  ) {}

  /** The `createMcpHandler` factory. */
  readonly forRequest = (ctx: McpRequestContext): McpServer => this.create(callerOf(ctx))

  create(caller: AuthContext): McpServer {
    const server = new McpServer({ name: 'boxlite', version: '0.0.1' })
    server.registerTool(
      'list_boxes',
      {
        description: 'List the boxes in one of your BoxLite organizations.',
        inputSchema: listBoxesInputSchema,
        outputSchema: listBoxesOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      ({ organization_id }) => this.listBoxes(caller, organization_id),
    )
    this.volumeTools.register(server, caller)
    this.imageTools.register(server, caller)
    this.registryTools.register(server, caller)
    this.boxTools.register(server, caller)
    this.networkTools.register(server, caller)
    registerConfigTool(server)
    this.executionTools.register(server, caller)
    this.fileTools.register(server, caller)
    this.metricsTools.register(server, caller)
    return server
  }

  private async listBoxes(caller: AuthContext, organizationId: string): Promise<CallToolResult> {
    if (!(await this.organizationUserService.exists(organizationId, caller.userId))) {
      return { isError: true, content: [{ type: 'text', text: ORGANIZATION_DENIED }] }
    }
    // The same lookup and mapping as REST `GET /v1/boxes`.
    const boxes = await this.boxService.toBoxDtos(await this.boxService.findAllDeprecated(organizationId))
    const result = boxes.map(boxToBoxResponse)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  }
}

function callerOf(ctx: McpRequestContext): AuthContext {
  const caller = ctx.authInfo?.extra?.[MCP_CALLER_KEY]
  // The handler is only reached behind the JWT guard, so a missing caller is a wiring bug.
  if (!caller) {
    throw new Error('MCP request reached the server factory without an authenticated caller')
  }
  return caller as AuthContext
}
