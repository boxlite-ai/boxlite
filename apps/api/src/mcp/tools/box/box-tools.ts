/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { Context } from '../../../common/context/context'
import { AuditAction } from '../../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../../audit/enums/audit-target.enum'
import { BoxService } from '../../../box/services/box.service'
import { BoxStateWaiterService } from '../../../box/services/box-state-waiter.service'
import { BoxState } from '../../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../../box/enums/box-desired-state.enum'
import type { BoxDto } from '../../../box/dto/box.dto'
import { MAX_NETWORK_ALLOW_LIST_ENTRIES } from '../../../box/utils/network-validation.util'
import { CreateBoxDto } from '../../../boxlite-rest/dto/create-box.dto'
import { boxToBoxResponse, createBoxToCreateBox } from '../../../boxlite-rest/mappers/box-to-box.mapper'
import { CommerceBoxLimitService } from '../../../boxlite-rest/commerce-box-limit.service'
import { OrganizationResourcePermission as Permission } from '../../../organization/enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../../../organization/guards/organization-resource-action.guard'
import { McpToolAccess } from '../shared/mcp-tool-access'
import { McpToolAudit } from '../shared/mcp-tool-audit'
import {
  boxResponseSchema,
  boxSelectorSchema,
  boxToolInput,
  listBoxesInputSchema,
  listBoxesOutputSchema,
} from './box.schema'
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

const boxOutput = boxResponseSchema.strict()
const directionMode = z.enum(['enabled', 'disabled'])
const createInput = z.strictObject({
  ...organizationInput,
  name: boxSelectorSchema.optional(),
  image: z.string().optional(),
  cpus: z.number().int().min(1).optional(),
  memory_mib: z.number().int().min(256).optional(),
  disk_size_gb: z.number().int().min(1).optional(),
  working_dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  user: z.string().optional(),
  auto_stop: z.number().min(0).optional(),
  auto_delete: z.number().min(0).optional(),
  auto_resume: z.boolean().optional(),
  network: z
    .strictObject({
      outbound: z
        .strictObject({
          mode: directionMode,
          allow_net: z.array(z.string()).max(MAX_NETWORK_ALLOW_LIST_ENTRIES).optional(),
        })
        .optional(),
      inbound: z.strictObject({ mode: directionMode, allow_net: z.array(z.string()).max(0).optional() }).optional(),
    })
    .optional(),
  volumes: z
    .array(
      z.strictObject({
        managed_volume: z.string().min(1),
        guest_path: z.string(),
        read_only: z.literal(false).optional(),
      }),
    )
    .optional(),
  secrets: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        value: z.string().min(1),
        hosts: z.array(z.string()).optional(),
        placeholder: z.string().optional(),
      }),
    )
    .optional(),
})

@Injectable()
export class BoxTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly boxes: BoxService,
    private readonly waiter: BoxStateWaiterService,
    private readonly limits: CommerceBoxLimitService,
    private readonly audit: McpToolAudit,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'list_boxes',
      {
        description: 'List the boxes in one of your BoxLite organizations.',
        inputSchema: listBoxesInputSchema,
        outputSchema: listBoxesOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [], signal)
        assertMcpActive(signal)
        const boxes = await this.boxes.toBoxDtos(await this.boxes.findAllDeprecated(auth.organizationId))
        return boxes.map(boxResult)
      },
    )
    registerMcpTool(
      server,
      'get_box',
      {
        description: 'Get an owned Box by its ID or exact name, including recorded exit code.',
        inputSchema: boxToolInput,
        outputSchema: boxOutput,
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id, box_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [], signal)
        const box = await this.access.box(auth, box_id, signal)
        assertMcpActive(signal)
        return boxResult(await this.boxes.toBoxDtoWithExitCode(box))
      },
    )
    registerMcpTool(
      server,
      'box_exists',
      {
        description: 'Check whether an owned Box exists by its ID or exact name.',
        inputSchema: boxToolInput,
        outputSchema: z.strictObject({ exists: z.boolean() }),
        annotations: readOnlyAnnotations,
      },
      async ({ organization_id, box_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [], signal)
        try {
          await this.access.box(auth, box_id, signal)
          return { exists: true }
        } catch (error) {
          assertMcpActive(signal)
          if (error instanceof NotFoundException || error instanceof McpToolError) return { exists: false }
          throw error
        }
      },
    )
    registerMcpTool(
      server,
      'create_box',
      {
        description: 'Create a hosted Box from supported image options and wait up to 30 seconds for startup.',
        inputSchema: createInput,
        outputSchema: boxOutput,
        annotations: mutationAnnotations,
      },
      async ({ organization_id, ...request }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_BOXES], signal)
        const dto = await validateMcpDto(CreateBoxDto, request)
        if (
          dto.volumes?.length &&
          !hasOrganizationResourcePermissions(auth, [Permission.READ_VOLUMES, Permission.WRITE_VOLUMES])
        )
          throw new ForbiddenException()
        assertMcpActive(signal)
        const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(organization_id)
        return this.audit.run(
          auth,
          {
            tool: 'create_box',
            action: AuditAction.CREATE,
            targetType: AuditTarget.BOX,
            resultTargetId: (result) => result.box_id,
          },
          async () => {
            let box = await this.boxes.create(createBoxToCreateBox(dto), auth.organization, Context.user(), {
              maxCreatedBoxes,
            })
            if (box.state !== BoxState.STARTED) box = await this.waiter.waitForStarted(box.id, organization_id, 30)
            return boxResult(box)
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'delete_box',
      {
        description: 'Request Box deletion. Accepted does not mean background destruction has finished.',
        inputSchema: boxToolInput,
        outputSchema: acceptedOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, box_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.DELETE_BOXES], signal)
        const box = await this.access.box(auth, box_id, signal)
        return this.audit.run(
          auth,
          { tool: 'delete_box', action: AuditAction.DELETE, targetType: AuditTarget.BOX, targetId: box.id },
          async () => {
            await this.boxes.destroy(box.id, organization_id, Context.user())
            return { accepted: true as const }
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'start_box',
      {
        description: 'Start an owned Box and wait up to 30 seconds for startup.',
        inputSchema: boxToolInput,
        outputSchema: boxOutput,
        annotations: mutationAnnotations,
      },
      async ({ organization_id, box_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_BOXES], signal)
        const box = await this.access.box(auth, box_id, signal)
        return this.audit.run(
          auth,
          { tool: 'start_box', action: AuditAction.START, targetType: AuditTarget.BOX, targetId: box.id },
          async () => {
            const starting =
              box.desiredState === BoxDesiredState.STARTED &&
              [BoxState.UNKNOWN, BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING].includes(box.state)
            if (starting) return boxResult(await this.waiter.waitForStarted(box.id, organization_id, 30))
            const started = await this.boxes.start(box.id, auth.organization)
            let dto = await this.boxes.toBoxDto(started)
            if (dto.state !== BoxState.STARTED) dto = await this.waiter.waitForStarted(box.id, organization_id, 30)
            return boxResult(dto)
          },
          signal,
        )
      },
    )
    registerMcpTool(
      server,
      'stop_box',
      {
        description: 'Request Box stop and return its current lifecycle state; stopping may still be in progress.',
        inputSchema: boxToolInput,
        outputSchema: boxOutput,
        annotations: destructiveAnnotations,
      },
      async ({ organization_id, box_id }, context) => {
        const signal = context.mcpReq.signal
        const auth = await this.access.organization(caller, organization_id, [Permission.WRITE_BOXES], signal)
        const box = await this.access.box(auth, box_id, signal)
        return this.audit.run(
          auth,
          { tool: 'stop_box', action: AuditAction.STOP, targetType: AuditTarget.BOX, targetId: box.id },
          async () =>
            boxResult(await this.boxes.toBoxDto(await this.boxes.stop(box.id, organization_id, Context.user()))),
          signal,
        )
      },
    )
  }
}

function boxResult(dto: BoxDto) {
  return boxOutput.parse(boxToBoxResponse(dto))
}
