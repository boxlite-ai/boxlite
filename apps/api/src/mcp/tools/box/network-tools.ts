/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { AuditAction } from '../../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../../audit/enums/audit-target.enum'
import { BoxService } from '../../../box/services/box.service'
import { TunnelService } from '../../../box/services/tunnel.service'
import { AUTO_RESUMABLE_STATES } from '../../../box/services/box-auto-resume.service'
import { BoxState } from '../../../box/enums/box-state.enum'
import { InboundNetworkSpecDto } from '../../../boxlite-rest/dto/create-box.dto'
import { OrganizationResourcePermission as Permission } from '../../../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from '../shared/mcp-tool-access'
import { McpToolAudit } from '../shared/mcp-tool-audit'
import { boxToolInput } from './box.schema'
import { McpToolError, registerMcpTool, validateMcpDto } from '../shared/mcp-tool'

const inboundMode = z.enum(['enabled', 'disabled'])
const tunnelPort = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .refine((port) => port !== 22222, { message: 'The terminal port is reserved' })
  .describe('Guest TCP port, excluding reserved terminal port 22222')

@Injectable()
export class NetworkTools {
  private readonly logger = new Logger(NetworkTools.name)

  constructor(
    private readonly access: McpToolAccess,
    private readonly boxes: BoxService,
    private readonly tunnels: TunnelService,
    private readonly audit: McpToolAudit,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'set_box_inbound',
      {
        description: 'Enable or disable public inbound access to an owned Box.',
        inputSchema: boxToolInput.extend({ mode: inboundMode }),
        outputSchema: z.strictObject({ mode: inboundMode }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ organization_id, box_id, mode }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_BOXES], signal)
        const box = await this.access.box(auth, box_id, signal)
        const dto = await validateMcpDto(InboundNetworkSpecDto, { mode })
        return this.audit.run(
          auth,
          {
            tool: 'set_box_inbound',
            action: AuditAction.UPDATE_INBOUND_ACCESS,
            targetType: AuditTarget.BOX,
            targetId: box.id,
          },
          async () => {
            const updated = await this.boxes.updateInboundEnabled(box.id, dto.mode === 'enabled', organization_id)
            return { mode: updated.inboundEnabled ? ('enabled' as const) : ('disabled' as const) }
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'prepare_tunnel',
      {
        description:
          'Prepare a public guest-port tunnel URL. Requires inbound access and a running or auto-resumable Box; the proxy wakes it on connection.',
        inputSchema: boxToolInput.extend({ port: tunnelPort }),
        outputSchema: z.strictObject({ uri: z.url() }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ organization_id, box_id, port }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_BOXES], signal)
        const box = await this.access.box(auth, box_id, signal)
        if (!box.inboundEnabled) throw new ConflictException('Inbound access must be enabled')
        return this.audit.run(
          auth,
          { tool: 'prepare_tunnel', action: AuditAction.CREATE, targetType: AuditTarget.BOX, targetId: box.id },
          async () => {
            await this.boxes
              .updateLastActivityAt(box.id, new Date())
              .catch(() => this.logger.warn('MCP tunnel activity update failed'))
            assertTunnelActive(signal)
            if (box.state !== BoxState.STARTED && (!box.autoResume || !AUTO_RESUMABLE_STATES.includes(box.state)))
              throw new ConflictException('Box cannot be reached in its current state')
            const uri = await this.boxes.getNetworkTunnelUrl(box.id, organization_id, port)
            assertTunnelActive(signal)
            await this.tunnels.prepare(box.id, port, true)
            return { uri }
          },
          signal,
        )
      },
    )
  }
}

function assertTunnelActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McpToolError('Tool call cancelled; Box activity may already have been recorded')
}
