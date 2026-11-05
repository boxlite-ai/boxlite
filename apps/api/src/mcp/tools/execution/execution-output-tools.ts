/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission } from '../../../organization/enums/organization-resource-permission.enum'
import { McpRunnerWebSocket } from '../../runner/runner-websocket'
import { McpToolAccess } from '../shared/mcp-tool-access'
import { destructiveAnnotations, organizationInput, registerMcpTool } from '../shared/mcp-tool'

@Injectable()
export class McpExecutionOutputTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly runner: McpRunnerWebSocket,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'get_execution_output',
      {
        description:
          'Capture bounded UTF-8 stdout/stderr from an execution through its single attach slot. ' +
          'Replay or live output may already be missing; history completeness is always unknown. ' +
          'Repeated calls can replay duplicate bytes and are not pagination. TTY merges stderr into stdout. ' +
          'Requires WRITE_BOXES, refreshes Box activity and may auto-resume. Closing this capture starts the Runner ' +
          'disconnect grace; an execution left disconnected may later be signaled and terminated. ' +
          'Conflicts with other attached clients. Sends no stdin or execution-control messages.',
        inputSchema: z.strictObject({
          ...organizationInput,
          box_id: z
            .string()
            .min(1)
            .max(256)
            .refine((value) => !value.includes('\0')),
          execution_id: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[a-zA-Z0-9_.-]+$/)
            .refine((value) => value !== '.' && value !== '..'),
          max_bytes: z
            .number()
            .int()
            .min(1)
            .max(64 * 1024)
            .default(32 * 1024)
            .describe(
              'Combined raw stdout/stderr byte budget, default 32768, maximum 65536. UTF-8 replacement can expand encoded result size.',
            ),
          wait_seconds: z
            .number()
            .int()
            .min(1)
            .max(15)
            .default(2)
            .describe(
              'Read deadline after WebSocket upgrade, default 2 seconds, range 1–15. Handshake has a separate five-second deadline.',
            ),
        }),
        outputSchema: z.strictObject({
          execution_id: z.string(),
          stdout: z.string(),
          stderr: z.string(),
          stop_reason: z.enum(['exit', 'time_limit', 'byte_limit']),
          exit_code: z.number().int().nullable(),
          limit_reached: z.boolean().describe('Capture stopped at its byte budget; further output may exist.'),
          history_complete: z
            .literal('unknown')
            .describe('Runner replay eviction and live subscriber loss are not reported by its protocol.'),
        }),
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, box_id, execution_id, max_bytes, wait_seconds }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(
          caller,
          organization_id,
          [OrganizationResourcePermission.WRITE_BOXES],
          signal,
        )
        return this.runner.capture(
          auth,
          box_id,
          execution_id,
          { maxBytes: max_bytes, waitSeconds: wait_seconds },
          signal,
        )
      },
    )
  }
}
