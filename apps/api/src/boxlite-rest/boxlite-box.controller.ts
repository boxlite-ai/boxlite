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
  Req,
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiResponse, ApiExcludeController } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import {
  OrganizationResourceActionGuard,
  hasOrganizationResourcePermissions,
} from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { UserContext } from '../common/decorators/user-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { recordBoxRequested } from '../box/utils/box-business-event.util'
import { Box } from '../box/entities/box.entity'
import { BoxDto } from '../box/dto/box.dto'
import { NetworkInfoResponseDto } from '../box/dto/network-info.dto'
import type { BoxNetworkProjection } from '../box/repositories/box.repository'
import { outboundRecord } from '../box/stores/outbound-policy.store'
import { validCompleteOutboundPolicy } from '../box/runner-adapter/outbound-control'
import { outboundPrecondition } from './outbound-precondition'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxResponseDto, ListBoxesResponseDto } from './dto/box-response.dto'
import { CreateBoxDto, InboundNetworkSpecDto, OutboundNetworkSpecDto } from './dto/create-box.dto'
import { boxToBoxResponse, completeCreateOutboundPolicy, createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { Audit, AUDIT_TARGET_ID, MASKED_AUDIT_VALUE, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { Context } from '../common/context/context'
import { BoxPageQuery } from './dto/box-page-query.dto'

const CHECKPOINT_BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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
    private readonly checkpointRecoverService: CheckpointRecoverService,
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
        checkpoint_id: req.body?.checkpoint_id,
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
    @UserContext() ctx: Context,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<BoxResponseDto> {
    if (dto.checkpoint_id !== undefined) {
      return this.createBoxFromCheckpoint(authContext, dto, ctx, request, response)
    }

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
    const completeOutbound = completeCreateOutboundPolicy(dto)

    let box = await this.boxService.create(createBoxDto, organization, ctx, {
      maxCreatedBoxes,
      ...(completeOutbound ? { completeOutbound } : {}),
    })
    if (request) request[AUDIT_TARGET_ID] = box.id
    if (box.state !== BoxState.STARTED) {
      const boxId = box.id
      if (completeOutbound) {
        box = await this.boxStateWaiter.waitForStarted(boxId, organization.id, 30, true).catch((error: unknown) => {
          const status = error instanceof HttpException ? error.getStatus() : 500
          const detail = error instanceof HttpException ? error.getResponse() : 'Complete outbound Box failed to start'
          const failure = new HttpException(
            {
              ...(typeof detail === 'string' ? { message: detail } : detail),
              creation_effect: 'allocated',
              boxId,
            },
            status,
            { cause: error },
          )
          const retryAfterSeconds = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds
          throw Object.assign(failure, { retryAfterSeconds })
        })
      } else {
        box = await this.boxStateWaiter.waitForStarted(boxId, organization.id, 30)
      }
    }
    return this.respondWithBox(box, organization.id, response)
  }

  /** Admit an inherited configuration, record its request, then wait without losing its identity. */
  private async createBoxFromCheckpoint(
    authContext: OrganizationAuthContext,
    dto: CreateBoxDto,
    ctx: Context,
    request?: Request,
    response?: Response,
  ): Promise<BoxResponseDto> {
    const overrides = Object.entries(dto)
      .filter(([field, value]) => value !== undefined && field !== 'checkpoint_id' && field !== 'name')
      .map(([field]) => field)
    if (overrides.includes('image')) {
      throw new BadRequestException('checkpoint_id and image are mutually exclusive')
    }
    if (overrides.length) {
      throw new BadRequestException(
        `A box created from a checkpoint inherits its settings; only name may be set, remove: ${overrides.join(', ')}`,
      )
    }
    if (dto.name !== undefined && (typeof dto.name !== 'string' || !CHECKPOINT_BOX_NAME.test(dto.name))) {
      throw new BadRequestException('Invalid box name')
    }

    const maxCreatedBoxes = await this.commerceBoxLimitService.resolveMaxCreatedBoxes(authContext.organizationId)
    const box = await this.checkpointRecoverService.createBox(
      authContext.organization,
      dto.checkpoint_id,
      dto.name,
      maxCreatedBoxes,
    )
    recordBoxRequested('box.create', box, ctx)
    if (request) request[AUDIT_TARGET_ID] = box.id
    try {
      const started = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
      return this.respondWithBox(started, authContext.organizationId, response)
    } catch (error) {
      // Admission already created this identity. Clients must query it after
      // any wait failure instead of submitting another anonymous Box.
      const status = error instanceof HttpException ? error.getStatus() : 500
      const detail = error instanceof HttpException ? error.getResponse() : 'Checkpoint box creation failed'
      throw new HttpException(
        { ...(typeof detail === 'string' ? { message: detail } : detail), boxId: box.id },
        status,
        {
          cause: error,
        },
      )
    }
  }

  // Mirrors OrganizationResourceActionGuard: a system admin and an interactive
  // owner without an API key are not permission-bounded; every other caller is
  // bounded by the permissions its credential carries. A static route decorator
  // cannot express this because it applies only when volumes are requested.
  private assertCanAttachVolumes(authContext: OrganizationAuthContext): void {
    const required = [OrganizationResourcePermission.READ_VOLUMES, OrganizationResourcePermission.WRITE_VOLUMES]
    if (!hasOrganizationResourcePermissions(authContext, required)) {
      throw new ForbiddenException(`Attaching a managed volume requires: ${required.join(', ')}`)
    }
  }

  /** Page the authenticated organization's live inventory with a continuation only when matches remain. */
  @Get()
  @ApiResponse({
    status: 200,
    description: 'List boxes',
    type: ListBoxesResponseDto,
  })
  async listBoxes(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() page: BoxPageQuery,
    @Param('prefix') prefix?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<ListBoxesResponseDto> {
    const organizationId = authContext.organizationId
    if (
      !organizationId ||
      authContext.organization?.id !== organizationId ||
      (prefix && prefix !== 'default' && prefix !== organizationId)
    ) {
      throw new BadRequestException('A resolved organization is required to list boxes')
    }
    const boxes = await this.boxService.findInventory(organizationId, {
      pageSize: page.pageSize,
      status: page.status,
      after: page.after(organizationId),
    })
    const returned = boxes.slice(0, page.pageSize)
    const dtos = await this.boxService.toBoxDtos(returned)
    return {
      boxes: await this.respondWithBoxes(dtos, organizationId, response),
      ...(boxes.length > page.pageSize
        ? { next_page_token: page.next(organizationId, returned[returned.length - 1].id) }
        : {}),
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
    @Res({ passthrough: true }) response?: Response,
  ): Promise<BoxResponseDto> {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    const dto = await this.boxService.toBoxDtoWithExitCode(box)
    return this.respondWithBox(dto, authContext.organizationId, response)
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
  async removeBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @UserContext() ctx: Context,
  ) {
    await this.boxService.destroy(boxId, authContext.organizationId, ctx)
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
    @UserContext() ctx: Context,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<BoxResponseDto> {
    let box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (request) request[AUDIT_TARGET_ID] = box.id

    if (this.isStartAlreadyInProgress(box)) {
      const dto = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
      return this.respondWithBox(dto, authContext.organizationId, response)
    }

    box = await this.boxService.start(box.id, authContext.organization, ctx, { idOnly: true })
    let dto = await this.boxService.toBoxDto(box)
    if (dto.state !== BoxState.STARTED) {
      dto = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
    }
    return this.respondWithBox(dto, authContext.organizationId, response)
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
    @UserContext() ctx: Context,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<BoxResponseDto> {
    const box = await this.boxService.stop(boxId, authContext.organizationId, ctx)
    const dto = await this.boxService.toBoxDto(box)
    return this.respondWithBox(dto, authContext.organizationId, response)
  }

  // The dashboard, CLI and SDKs all change inbound mode here, and only here.
  @Put(':boxId/network/inbound')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @ApiResponse({
    status: 200,
    description: 'Inbound access after the change',
    type: InboundNetworkSpecDto,
  })
  @Audit({
    action: AuditAction.UPDATE_INBOUND_ACCESS,
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
    const box = await this.boxService.updateInboundEnabled(boxId, dto.mode === 'enabled', authContext.organizationId)
    return { mode: box.inboundEnabled ? 'enabled' : 'disabled' }
  }

  @Get(':boxId/network/outbound')
  async getOutboundNetwork(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutboundNetworkSpecDto> {
    const snapshot = await this.boxService.getOutboundNetwork(boxId, authContext.organizationId)
    response.setHeader('ETag', `"${snapshot.revision}"`)
    return snapshot.policy
  }

  @Get(':boxId/network/outbound/status')
  async getOutboundStatus(@AuthContext() authContext: OrganizationAuthContext, @Param('boxId') boxId: string) {
    return this.boxService.getOutboundStatus(boxId, authContext.organizationId)
  }

  @Get(':boxId/network/outbound/complete')
  async getCompleteOutboundNetwork(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Res() response: Response,
  ): Promise<void> {
    const snapshot = await this.boxService.getCompleteOutboundNetwork(boxId, authContext.organizationId)
    response.setHeader('Cache-Control', 'private, no-store')
    if (snapshot === null) {
      // There is no representation validator for a policy that has not committed.
      // End the response directly so Express does not generate a weak error-body ETag.
      response
        .status(409)
        .type('json')
        .end(
          JSON.stringify({
            statusCode: 409,
            code: 'outbound_pending',
            message: 'No complete outbound snapshot is committed',
          }),
        )
      return
    }
    response.setHeader('ETag', `"${snapshot.revision}"`)
    response.json(snapshot)
  }

  @Get(':boxId/network/outbound/complete/status')
  async getCompleteOutboundStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.boxService.getCompleteOutboundStatus(boxId, authContext.organizationId)
  }

  @Put(':boxId/network/outbound/complete')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.UPDATE_NETWORK_SETTINGS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
  })
  async updateCompleteOutboundNetwork(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (request.headers['x-boxlite-outbound-revision'] !== undefined) {
      throw new BadRequestException('Outbound candidate revisions are internal control metadata')
    }
    const matches = outboundPrecondition(request.headers['if-match'])
    if (!validCompleteOutboundPolicy(body)) throw new BadRequestException('Invalid complete outbound policy')
    const result = await this.boxService.setCompleteOutboundNetwork(boxId, body, authContext.organizationId, matches)
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('ETag', `"${result.revision}"`)
    return result
  }

  @Put(':boxId/network/outbound')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @ApiResponse({ status: 200, type: OutboundNetworkSpecDto })
  @Audit({
    action: AuditAction.UPDATE_NETWORK_SETTINGS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: {
      body: (req: TypedRequest<OutboundNetworkSpecDto>) => ({ mode: req.body?.mode, allow_net: req.body?.allow_net }),
    },
  })
  async updateOutboundNetwork(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Body() dto: OutboundNetworkSpecDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutboundNetworkSpecDto> {
    if (request.headers['x-boxlite-outbound-revision'] !== undefined) {
      throw new BadRequestException('Outbound candidate revisions are internal control metadata')
    }
    const matches = outboundPrecondition(request.headers['if-match'])
    const box = await this.boxService.setOutboundNetwork(
      boxId,
      { mode: dto.mode, allow_net: dto.allow_net ?? [] },
      authContext.organizationId,
      matches,
    )
    response.setHeader('ETag', `"${outboundRecord(box).revision}"`)
    return { mode: box.outboundEnabled ? 'enabled' : 'disabled', allow_net: box.outboundAllowNet ?? [] }
  }

  private async respondWithBox(box: BoxDto, organizationId: string, response?: Response): Promise<BoxResponseDto> {
    const [result] = await this.respondWithBoxes([box], organizationId, response)
    return result
  }

  private async respondWithBoxes(
    boxes: BoxDto[],
    organizationId: string,
    response?: Response,
  ): Promise<BoxResponseDto[]> {
    response?.setHeader('Cache-Control', 'private, no-store')
    response?.vary('X-BoxLite-Source')
    const dashboard = response?.req.get('X-BoxLite-Source') === 'dashboard'
    const rows = await this.boxService
      .getBoxNetworkProjections(
        boxes.map((box) => box.id),
        organizationId,
      )
      .catch((): BoxNetworkProjection[] => {
        this.logger.warn('Box network metadata is unavailable')
        return []
      })
    const projections = new Map(rows.map((row) => [row.id, row]))
    return boxes.map((box) => {
      const result = boxToBoxResponse(box)
      delete result.network
      const row = projections.get(box.id)
      if (!row) return result
      const network = NetworkInfoResponseDto.fromBox(row)
      if (!row.protected) result.network = network
      else if (dashboard)
        result.network = { inbound: network.inbound, outbound: { mode: 'unavailable', allow_net: [] } }
      return result
    })
  }

  private isStartAlreadyInProgress(box: Box): boolean {
    return (
      box.desiredState === BoxDesiredState.STARTED &&
      [BoxState.UNKNOWN, BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING].includes(box.state)
    )
  }
}
