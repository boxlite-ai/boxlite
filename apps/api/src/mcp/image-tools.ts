/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext, OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { DIGEST_PATTERN, TAG_PATTERN } from '../image/utils/image-ref.util'
import { CreateAliasDto } from '../boxlite-rest/dto/create-alias.dto'
import { toImageDetail, toImageInfo } from '../boxlite-rest/mappers/image-response.mapper'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from './mcp-tool-access'
import { McpToolAudit } from './mcp-tool-audit'
import {
  assertMcpActive,
  completedOutput,
  destructiveAnnotations,
  mutationAnnotations,
  organizationInput,
  readOnlyAnnotations,
  registerMcpTool,
  validateMcpDto,
} from './mcp-tool'

const imageInput = z.strictObject({ ...organizationInput, image_name: z.string().min(1).max(512) })
const imageInfo = z.strictObject({
  reference: z.string(),
  repository: z.string(),
  tag: z.string(),
  id: z.string(),
  cached_at: z.string(),
  size_bytes: z.number(),
})
const imageDetail = z.strictObject({
  name: z.string(),
  aliases: z.array(z.string()),
  curated: z.boolean(),
  versions: z.array(
    z.strictObject({
      digest: z.string(),
      size_bytes: z.number(),
      source_ref: z.string(),
      recorded_at: z.string(),
      aliases: z.array(z.string()),
      last_used_at: z.string().nullable(),
      upstream_missing_at: z.string().nullable(),
    }),
  ),
  history: z.array(
    z.strictObject({
      alias: z.string(),
      from_digest: z.string().nullable(),
      to_digest: z.string(),
      actor: z.string().nullable(),
      recorded_at: z.string(),
    }),
  ),
})

@Injectable()
export class ImageTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly images: ImageCatalogService,
    private readonly audit: McpToolAudit,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'list_images',
      {
        description: 'List references recorded in your organization image catalog.',
        inputSchema: z.strictObject(organizationInput),
        outputSchema: z.strictObject({ images: z.array(imageInfo) }),
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.READ_IMAGES], signal)
        assertMcpActive(signal)
        return { images: (await this.images.listReferences(auth.organization)).map(toImageInfo) }
      },
    )
    registerMcpTool(
      server,
      'get_image_usage',
      {
        description: 'Get catalog image count, limit, and known storage bytes.',
        inputSchema: z.strictObject(organizationInput),
        outputSchema: z.strictObject({ count: z.number(), limit: z.number(), known_bytes: z.number() }),
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.READ_IMAGES], signal)
        assertMcpActive(signal)
        const usage = await this.images.usage(auth.organization)
        return { count: usage.count, limit: usage.limit, known_bytes: usage.knownBytes }
      },
    )
    registerMcpTool(
      server,
      'get_image',
      {
        description: 'Get an organization image, versions and alias history.',
        inputSchema: imageInput,
        outputSchema: imageDetail,
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id, image_name }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.READ_IMAGES], signal)
        return toImageDetail(await this.ownedImage(auth, image_name, signal))
      },
    )
    registerMcpTool(
      server,
      'create_image_alias',
      {
        description: 'Create a new catalog alias pointing to a ready manifest digest.',
        inputSchema: imageInput.extend({
          alias: z.string().regex(TAG_PATTERN),
          digest: z.string().regex(DIGEST_PATTERN),
        }),
        outputSchema: imageDetail,
        annotations: mutationAnnotations,
      },
      async ({ organization_id, image_name, ...request }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_IMAGES], signal)
        const dto = await validateMcpDto(CreateAliasDto, request)
        await this.ownedImage(auth, image_name, signal)
        return this.audit.run(
          auth,
          {
            tool: 'create_image_alias',
            action: AuditAction.CREATE,
            targetType: AuditTarget.IMAGE,
            targetId: image_name,
          },
          async () =>
            toImageDetail(
              await this.images.createAlias(
                auth.organization,
                image_name,
                dto.alias,
                { digest: dto.digest },
                auth.userId,
              ),
            ),
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'delete_image_alias',
      {
        description: 'Delete a catalog alias while retaining its versions and existing boxes.',
        inputSchema: imageInput.extend({ alias: z.string().regex(TAG_PATTERN) }),
        outputSchema: completedOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, image_name, alias }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_IMAGES], signal)
        await this.ownedImage(auth, image_name, signal)
        return this.audit.run(
          auth,
          {
            tool: 'delete_image_alias',
            action: AuditAction.DELETE,
            targetType: AuditTarget.IMAGE,
            targetId: image_name,
          },
          async () => {
            await this.images.deleteAlias(auth.organization, image_name, alias)
            return { completed: true as const }
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'delete_image',
      {
        description: 'Remove an unused image catalog entry; this does not erase registry or cached image bytes.',
        inputSchema: imageInput,
        outputSchema: completedOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, image_name }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.DELETE_IMAGES], signal)
        await this.ownedImage(auth, image_name, signal)
        return this.audit.run(
          auth,
          { tool: 'delete_image', action: AuditAction.DELETE, targetType: AuditTarget.IMAGE, targetId: image_name },
          async () => {
            await this.images.delete(auth.organization, image_name)
            return { completed: true as const }
          },
          signal,
        )
      },
    )
  }

  private async ownedImage(auth: OrganizationAuthContext, name: string, signal?: AbortSignal) {
    assertMcpActive(signal)
    const image = await this.images.get(auth.organization, name)
    assertMcpActive(signal)
    return image
  }
}
