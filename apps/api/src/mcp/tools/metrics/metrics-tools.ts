/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { McpToolAccess } from '../shared/mcp-tool-access'
import { McpToolError, organizationInput, readOnlyAnnotations, registerMcpTool } from '../shared/mcp-tool'
import { McpRunnerHttp } from '../../runner/runner-http'

const counter = z.number().int().nonnegative()
const metrics = z.object({
  commands_executed_total: counter,
  exec_errors_total: counter,
  bytes_sent_total: counter,
  bytes_received_total: counter,
  cpu_percent: z.number().finite().nonnegative().nullable(),
  memory_bytes: counter.nullable(),
  network_bytes_sent: counter.nullable().optional(),
  network_bytes_received: counter.nullable().optional(),
  network_tcp_connections: counter.nullable().optional(),
  network_tcp_errors: counter.nullable().optional(),
})

@Injectable()
export class McpMetricsTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly runner: McpRunnerHttp,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'get_box_metrics',
      {
        description:
          'Observe the Box CPU, memory, execution and available network counters. This does not refresh activity or auto-resume a stopped Box.',
        inputSchema: z.strictObject({
          ...organizationInput,
          box_id: z
            .string()
            .min(1)
            .max(256)
            .refine((value) => !value.includes('\0')),
        }),
        outputSchema: metrics,
        annotations: readOnlyAnnotations,
      },
      async (args, context) => {
        const auth = await this.access.organization(caller, args.organization_id, [], context.mcpReq.signal)
        const { body } = await this.runner.execute(auth, args.box_id, { kind: 'metrics' }, context.mcpReq.signal)
        try {
          return metrics.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
        } catch {
          throw new McpToolError('Invalid Runner metrics response', {
            source: 'runner',
            operation: 'metrics',
            code: 'invalid_response',
            message: 'Invalid Runner metrics response',
          })
        }
      },
    )
  }
}
