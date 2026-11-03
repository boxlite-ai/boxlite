/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext, OrganizationAuthContext } from '../../../common/interfaces/auth-context.interface'
import { AuditAction } from '../../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../../audit/enums/audit-target.enum'
import { VolumeService } from '../../../box/services/volume.service'
import { CreateVolumeDto, VOLUME_NAME_PATTERN } from '../../../box/dto/create-volume.dto'
import type { Volume } from '../../../box/entities/volume.entity'
import { VolumeState } from '../../../box/enums/volume-state.enum'
import { toVolumeResponse, toVolumeSummary } from '../../../boxlite-rest/mappers/volume-response.mapper'
import { OrganizationResourcePermission as Permission } from '../../../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from '../shared/mcp-tool-access'
import { McpToolAudit } from '../shared/mcp-tool-audit'
import {
  acceptedOutput,
  assertMcpActive,
  destructiveAnnotations,
  McpToolError,
  mutationAnnotations,
  organizationInput,
  readOnlyAnnotations,
  registerMcpTool,
  validateMcpDto,
} from '../shared/mcp-tool'

const volumeSummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  state: z.enum(VolumeState),
  created_at: z.string(),
})
const volumeResponse = volumeSummary.extend({
  updated_at: z.string(),
  last_used_at: z.string().optional(),
  error_reason: z.string().optional(),
})
const volumeInput = z.strictObject({ ...organizationInput, volume_id: z.uuid() })

@Injectable()
export class VolumeTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly volumes: VolumeService,
    private readonly audit: McpToolAudit,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'list_volumes',
      {
        description: 'List managed volumes in one of your organizations.',
        inputSchema: z.strictObject(organizationInput),
        outputSchema: z.strictObject({ volumes: z.array(volumeSummary) }),
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id }, context) => {
        await this.access.organization(caller, organization_id, [Permission.READ_VOLUMES], context.mcpReq.signal)
        assertMcpActive(context.mcpReq.signal)
        return { volumes: (await this.volumes.findAll(organization_id)).map(toVolumeSummary) }
      },
    )
    registerMcpTool(
      server,
      'get_volume',
      {
        description: 'Get a managed volume belonging to your organization.',
        inputSchema: volumeInput,
        outputSchema: volumeResponse,
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id, volume_id }, context) => {
        const auth = await this.access.organization(
          caller,
          organization_id,
          [Permission.READ_VOLUMES],
          context.mcpReq.signal,
        )
        return volumeResult(await this.ownedVolume(auth, volume_id, context.mcpReq.signal))
      },
    )
    registerMcpTool(
      server,
      'create_volume',
      {
        description: 'Create a managed volume and wait up to 30 seconds for it to become ready.',
        inputSchema: z.strictObject({ ...organizationInput, name: z.string().regex(VOLUME_NAME_PATTERN).optional() }),
        outputSchema: volumeResponse,
        annotations: mutationAnnotations,
      },
      async ({ organization_id, ...request }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_VOLUMES], signal)
        const dto = await validateMcpDto(CreateVolumeDto, request)
        return this.audit.run(
          auth,
          {
            tool: 'create_volume',
            action: AuditAction.CREATE,
            targetType: AuditTarget.VOLUME,
            resultTargetId: (result) => result.id,
          },
          async () => {
            const volume = await this.volumes.create(auth.organization, dto)
            return volumeResult(await this.volumes.waitForReady(volume.id, 30))
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'delete_volume',
      {
        description: 'Request managed volume deletion; accepted does not mean storage deletion has completed.',
        inputSchema: volumeInput.extend({ force: z.boolean().optional() }),
        outputSchema: acceptedOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, volume_id, force = false }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.DELETE_VOLUMES], signal)
        try {
          await this.ownedVolume(auth, volume_id, signal)
        } catch (error) {
          if (!(force && error instanceof NotFoundException)) throw error
          return { accepted: true as const }
        }
        return this.audit.run(
          auth,
          { tool: 'delete_volume', action: AuditAction.DELETE, targetType: AuditTarget.VOLUME, targetId: volume_id },
          async () => {
            await this.volumes.delete(volume_id, force)
            return { accepted: true as const }
          },
          signal,
        )
      },
    )
  }

  private async ownedVolume(auth: OrganizationAuthContext, id: string, signal?: AbortSignal) {
    assertMcpActive(signal)
    const volume = await this.volumes.findOne(id)
    assertMcpActive(signal)
    if (volume.organizationId !== auth.organizationId) throw new McpToolError('Resource not found or not accessible')
    return volume
  }
}

function volumeResult(volume: Volume) {
  const response = toVolumeResponse(volume)
  return { ...response, error_reason: response.error_reason ?? undefined }
}
