/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { OrganizationService } from '../../../organization/services/organization.service'
import { assertMcpActive, readOnlyAnnotations, registerMcpTool } from '../shared/mcp-tool'

@Injectable()
export class OrganizationTools {
  constructor(private readonly organizations: OrganizationService) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'list_organizations',
      {
        description: 'List your BoxLite organizations. Use an id as organization_id in organization-scoped tools.',
        inputSchema: z.strictObject({}),
        outputSchema: z.array(
          z.strictObject({
            id: z.uuid(),
            name: z.string(),
            is_default: z.boolean(),
          }),
        ),
        annotations: readOnlyAnnotations,
      },
      async (_args, context) => {
        const signal = context.mcpReq.signal
        assertMcpActive(signal)
        const memberships = await this.organizations.findByUserWithDefaultFlag(caller.userId)
        assertMcpActive(signal)
        return memberships
          .filter(({ organization }) => !caller.apiKey || caller.apiKey.organizationId === organization.id)
          .map(({ organization, isDefaultForAuthenticatedUser }) => ({
            id: organization.id,
            name: organization.name,
            is_default: isDefaultForAuthenticatedUser,
          }))
      },
    )
  }
}
