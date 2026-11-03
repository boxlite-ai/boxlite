/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
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
    private readonly boxTools: BoxTools,
    private readonly volumeTools: VolumeTools,
    private readonly imageTools: ImageTools,
    private readonly registryTools: RegistryTools,
    private readonly networkTools: NetworkTools,
    private readonly executionTools: McpExecutionTools,
    private readonly fileTools: McpFileTools,
    private readonly metricsTools: McpMetricsTools,
  ) {}

  /** The `createMcpHandler` factory. */
  readonly forRequest = (ctx: McpRequestContext): McpServer => this.create(callerOf(ctx))

  create(caller: AuthContext): McpServer {
    const server = new McpServer({ name: 'boxlite', version: '0.0.1' })
    this.boxTools.register(server, caller)
    this.volumeTools.register(server, caller)
    this.imageTools.register(server, caller)
    this.registryTools.register(server, caller)
    this.networkTools.register(server, caller)
    registerConfigTool(server)
    this.executionTools.register(server, caller)
    this.fileTools.register(server, caller)
    this.metricsTools.register(server, caller)
    return server
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
