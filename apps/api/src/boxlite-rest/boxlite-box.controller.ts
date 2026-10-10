/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Head,
  Body,
  Param,
  Query,
  HttpCode,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Logger,
  Res,
  ForbiddenException,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiResponse, ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { SystemRole } from '../user/enums/system-role.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxResponseDto, ListBoxesResponseDto } from './dto/box-response.dto'
import { CreateBoxDto, InboundNetworkSpecDto } from './dto/create-box.dto'
import { boxToBoxResponse, createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { Audit, MASKED_AUDIT_VALUE, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CommerceBoxLimitService } from './commerce-box-limit.service'

// Spec-first surface: the contract is openapi/box.openapi.yaml, not the
// generated product spec (which `:prefix` routes would render invalid).
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
// The spec declares `additionalProperties: false` on CreateBoxRequest, and the
// other two servers enforce it — `boxlite serve` through
// `#[serde(deny_unknown_fields)]`, the reference server through
// `extra="forbid"`. Without this, a body carrying a sandbox knob
// (`security`, `advanced.security`, `privileged`) or a host path
// (`rootfs_path`) is accepted and silently forgotten: the caller gets a 201
// and a box that ignored what they asked for.
//
// Scoped to this controller rather than the global pipe in main.ts, which also
// serves the dashboard, admin, runner-callback and webhook routes — none of
// which are covered by this spec, and all of which would change behaviour in
// the same commit.
//
// `whitelist` alone only strips unknown fields; `forbidNonWhitelisted` is what
// turns a stripped field into a 400. Both are required.
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
@ApiBearerAuth()
export class BoxliteBoxController {
  private readonly logger = new Logger(BoxliteBoxController.name)

  constructor(
    private readonly boxService: BoxService,
    private readonly boxStateWaiter: BoxStateWaiterService,
    private readonly commerceBoxLimitService: CommerceBoxLimitService,
  ) {}

  @Post()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(201)
  @ApiResponse({
    status: 201,
    description: 'Box created',
    type: BoxResponseDto,
  })
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.BOX,
    targetIdFromResult: (result: BoxResponseDto) => result?.box_id,
    requestMetadata: {
      body: (req: TypedRequest<CreateBoxDto>) => ({
        name: req.body?.name,
        image: req.body?.image,
        user: req.body?.user,
        env: req.body?.env
          ? Object.fromEntries(Object.keys(req.body?.env).map((key) => [key, MASKED_AUDIT_VALUE]))
          : undefined,
        secrets: req.body?.secrets?.map((s) => ({
          name: s.name,
          hosts: s.hosts,
          value: MASKED_AUDIT_VALUE,
        })),
        cpus: req.body?.cpus,
        memory_mib: req.body?.memory_mib,
        disk_size_gb: req.body?.disk_size_gb,
        working_dir: req.body?.working_dir,
        entrypoint: req.body?.entrypoint,
        cmd: req.body?.cmd,
        detach: req.body?.detach,
        auto_stop: req.body?.auto_stop,
        auto_delete: req.body?.auto_delete,
        auto_resume: req.body?.auto_resume,
        network: req.body?.network,
      }),
    },
  })
  async createBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateBoxDto,
  ): Promise<BoxResponseDto> {
    // Attaching a managed volume grants the box read/write access to its data,
    // so it is authorized independently of WRITE_BOXES: the caller must hold the
    // volume permissions too. WRITE_BOXES alone must not reach another key's
    // volumes (GHSA-2qqv-7cwv-mj8h).
    if (dto.volumes?.length) {
      this.assertCanAttachVolumes(authContext)
    }

    const organization = authContext.organization
    const createBoxDto = createBoxToCreateBox(dto)
    const maxCreatedBoxes = await this.commerceBoxLimitService.resolveMaxCreatedBoxes(organization.id)

    let box = await this.boxService.create(createBoxDto, organization, { maxCreatedBoxes, actorKind: 'user' })
    if (box.state !== BoxState.STARTED) {
      box = await this.boxStateWaiter.waitForStarted(box.id, organization.id, 30)
    }
    return boxToBoxResponse(box)
  }

  // Mirrors OrganizationResourceActionGuard: a system admin and an interactive
  // owner without an API key are not permission-bounded; every other caller is
  // bounded by the permissions its credential carries. A static route decorator
  // cannot express this because it applies only when volumes are requested.
  private assertCanAttachVolumes(authContext: OrganizationAuthContext): void {
    if (authContext.role === SystemRole.ADMIN) {
      return
    }
    if (authContext.organizationUser?.role === OrganizationMemberRole.OWNER && !authContext.apiKey) {
      return
    }

    const held = new Set(
      authContext.apiKey
        ? authContext.apiKey.permissions
        : (authContext.organizationUser?.assignedRoles ?? []).flatMap((role) => role.permissions),
    )
    const required = [OrganizationResourcePermission.READ_VOLUMES, OrganizationResourcePermission.WRITE_VOLUMES]
    const missing = required.filter((permission) => !held.has(permission))
    if (missing.length) {
      throw new ForbiddenException(`Attaching a managed volume requires: ${missing.join(', ')}`)
    }
  }

  @Get()
  @ApiResponse({
    status: 200,
    description: 'List boxes',
    type: ListBoxesResponseDto,
  })
  async listBoxes(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query('pageSize') pageSize?: string,
  ): Promise<ListBoxesResponseDto> {
    const boxes = await this.boxService.findAllDeprecated(authContext.organizationId)
    const dtos = await this.boxService.toBoxDtos(boxes)
    return {
      boxes: dtos.map(boxToBoxResponse),
    }
  }

  @Get(':boxId')
  @ApiResponse({
    status: 200,
    description: 'Box details',
    type: BoxResponseDto,
  })
  async getBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    const dto = await this.boxService.toBoxDtoWithExitCode(box)
    return boxToBoxResponse(dto)
  }

  @Head(':boxId')
  async headBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Res() res: Response,
  ) {
    try {
      await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
      res.status(204).end()
    } catch {
      res.status(404).end()
    }
  }

  @Delete(':boxId')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  @HttpCode(204)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
  })
  async removeBox(@AuthContext() authContext: OrganizationAuthContext, @Param('boxId') boxId: string) {
    await this.boxService.destroy(boxId, authContext.organizationId, 'user')
  }

  @Post(':boxId/start')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @ApiResponse({
    status: 201,
    description: 'Box start requested',
    type: BoxResponseDto,
  })
  @Audit({
    action: AuditAction.START,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    targetIdFromResult: (result: BoxResponseDto) => result?.box_id,
  })
  async startBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    let box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)

    if (this.isStartAlreadyInProgress(box)) {
      const dto = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
      return boxToBoxResponse(dto)
    }

    box = await this.boxService.start(boxId, authContext.organization)
    let dto = await this.boxService.toBoxDto(box)
    if (dto.state !== BoxState.STARTED) {
      dto = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
    }
    return boxToBoxResponse(dto)
  }

  @Post(':boxId/stop')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @ApiResponse({
    status: 201,
    description: 'Box stop requested',
    type: BoxResponseDto,
  })
  @Audit({
    action: AuditAction.STOP,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    targetIdFromResult: (result: BoxResponseDto) => result?.box_id,
  })
  async stopBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    const box = await this.boxService.stop(boxId, authContext.organizationId, 'user')
    const dto = await this.boxService.toBoxDto(box)
    return boxToBoxResponse(dto)
  }

  // The dashboard flips the same `public` flag through
  // `POST /api/box/:id/public/:isPublic`, which requires WRITE_BOXES. Requiring
  // it here too keeps this from being a weaker route to that operation.
  @Put(':boxId/network/inbound')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @ApiResponse({
    status: 200,
    description: 'Inbound access after the change',
    type: InboundNetworkSpecDto,
  })
  @Audit({
    action: AuditAction.UPDATE_PUBLIC_STATUS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: {
      body: (req: TypedRequest<InboundNetworkSpecDto>) => ({ mode: req.body?.mode }),
    },
  })
  async updateInboundNetwork(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Body() dto: InboundNetworkSpecDto,
  ): Promise<InboundNetworkSpecDto> {
    const box = await this.boxService.updatePublicStatus(boxId, dto.mode === 'enabled', authContext.organizationId)
    return { mode: box.public ? 'enabled' : 'disabled' }
  }

  private isStartAlreadyInProgress(box: Box): boolean {
    return (
      box.desiredState === BoxDesiredState.STARTED &&
      [BoxState.UNKNOWN, BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING].includes(box.state)
    )
  }
}
