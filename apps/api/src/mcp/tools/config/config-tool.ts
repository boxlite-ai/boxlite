/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { getHostedBoxConfig } from '../../../boxlite-rest/hosted-box-config'
import { readOnlyAnnotations, registerMcpTool } from '../shared/mcp-tool'

export function registerConfigTool(server: McpServer): void {
  registerMcpTool(
    server,
    'get_config',
    {
      description: 'Get public hosted Box capabilities. This contains no organization or deployment secrets.',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({
        capabilities: z.strictObject({
          privileged_enabled: z.boolean(),
          snapshots_enabled: z.boolean(),
          clone_enabled: z.boolean(),
          export_enabled: z.boolean(),
          import_enabled: z.boolean(),
          inbound_update_enabled: z.boolean(),
          private_tunnels_enabled: z.boolean(),
          exec_user_enabled: z.boolean(),
        }),
      }),
      annotations: readOnlyAnnotations,
    },
    async () => getHostedBoxConfig(),
  )
}
