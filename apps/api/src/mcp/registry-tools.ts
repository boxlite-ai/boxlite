/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RegistriesService } from '../registry/services/registries.service'
import { REPOSITORY_PREFIX } from '../registry/dto/registry-credential.dto'
import { credentialedRegistryHosts } from '../registry/utils/registry-proxy.util'
import { CreateRegistryDto } from '../boxlite-rest/dto/create-registry.dto'
import { toRestCredential } from '../boxlite-rest/mappers/registry-response.mapper'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from './mcp-tool-access'
import { McpToolAudit } from './mcp-tool-audit'
import {
  assertMcpActive,
  completedOutput,
  destructiveAnnotations,
  McpToolError,
  mutationAnnotations,
  organizationInput,
  readOnlyAnnotations,
  registerMcpTool,
  validateMcpDto,
} from './mcp-tool'

const registryResponse = z.strictObject({
  id: z.string(),
  registry_host: z.string(),
  repository_prefix: z.string(),
  username: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string(),
})

@Injectable()
export class RegistryTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly registries: RegistriesService,
    private readonly audit: McpToolAudit,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'list_registries',
      {
        description: 'List public registry credential metadata without passwords or secret-store references.',
        inputSchema: z.strictObject(organizationInput),
        outputSchema: z.strictObject({ registries: z.array(registryResponse) }),
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id }, context) => {
        const signal = context.mcpReq.signal
        await this.access.organization(caller, organization_id, [Permission.READ_REGISTRIES], signal)
        assertMcpActive(signal)
        return { registries: (await this.registries.list(organization_id)).map(toRestCredential) }
      },
    )
    registerMcpTool(
      server,
      'create_registry',
      {
        description: 'Register a private registry login. The password is write-only and is never returned.',
        inputSchema: z.strictObject({
          ...organizationInput,
          registry_host: z.enum(credentialedRegistryHosts()),
          repository_prefix: z.string().max(255).regex(REPOSITORY_PREFIX).optional(),
          username: z.string().min(1).max(255),
          password: z.string().min(1).max(8192),
        }),
        outputSchema: registryResponse,
        annotations: mutationAnnotations,
      },
      async ({ organization_id, ...request }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_REGISTRIES], signal)
        const dto = await validateMcpDto(CreateRegistryDto, request)
        return this.audit.run(
          auth,
          {
            tool: 'create_registry',
            action: AuditAction.CREATE,
            targetType: AuditTarget.REGISTRY_CREDENTIAL,
            resultTargetId: (result) => result.id,
          },
          async () =>
            toRestCredential(
              await this.registries.create(organization_id, auth.userId, {
                registryHost: dto.registry_host,
                repositoryPrefix: dto.repository_prefix,
                username: dto.username,
                password: dto.password,
              }),
            ),
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'delete_registry',
      {
        description: 'Delete an owned registry login unless an existing box still pulls through it.',
        inputSchema: z.strictObject({ ...organizationInput, registry_id: z.uuid() }),
        outputSchema: completedOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, registry_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.DELETE_REGISTRIES], signal)
        assertMcpActive(signal)
        const owned = (await this.registries.list(organization_id)).some(
          (credential) => credential.id === registry_id && credential.organizationId === organization_id,
        )
        if (!owned) throw new McpToolError('Resource not found or not accessible')
        return this.audit.run(
          auth,
          {
            tool: 'delete_registry',
            action: AuditAction.DELETE,
            targetType: AuditTarget.REGISTRY_CREDENTIAL,
            targetId: registry_id,
          },
          async () => {
            await this.registries.delete(organization_id, registry_id)
            return { completed: true as const }
          },
          signal,
        )
      },
    )
  }
}
