/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Head,
  Body,
  BadRequestException,
  Param,
  Query,
  HttpCode,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Logger,
  Res,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiResponse, ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxResponseDto, GetOrCreateBoxResponseDto, ListBoxesResponseDto } from './dto/box-response.dto'
import { CreateBoxDto } from './dto/create-box.dto'
import { boxToBoxResponse, createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { Audit, MASKED_AUDIT_VALUE, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'

const LEGACY_CAPABILITY_FIELDS = ['capAdd', 'capDrop', 'cap_add', 'cap_drop'] as const

// Spec-first surface: the contract is openapi/box.openapi.yaml, not the
// generated product spec (which `:prefix` routes would render invalid).
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteBoxController {
  private readonly logger = new Logger(BoxliteBoxController.name)

  constructor(
    private readonly boxService: BoxService,
    private readonly boxStateWaiter: BoxStateWaiterService,
  ) {}

  @Post()
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
        cpus: req.body?.cpus,
        memory_mib: req.body?.memory_mib,
        disk_size_gb: req.body?.disk_size_gb,
        working_dir: req.body?.working_dir,
        entrypoint: req.body?.entrypoint,
        cmd: req.body?.cmd,
        advanced: req.body?.advanced,
        detach: req.body?.detach,
        auto_pause: req.body?.auto_pause,
        auto_delete: req.body?.auto_delete,
        auto_resume: req.body?.auto_resume,
      }),
    },
  })
  async createBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateBoxDto,
  ): Promise<BoxResponseDto> {
    const request = dto as CreateBoxDto & Record<string, unknown>
    const hasFlatCapabilityField = LEGACY_CAPABILITY_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(request, field),
    )
    if (dto.advanced !== undefined || hasFlatCapabilityField) {
      throw new BadRequestException('advanced options require POST /v1/boxes/strict')
    }
    return this.createBoxWithOptions(authContext, dto)
  }

  private async createBoxWithOptions(authContext: OrganizationAuthContext, dto: CreateBoxDto): Promise<BoxResponseDto> {
    const organization = authContext.organization
    const createBoxDto = createBoxToCreateBox(dto)

    let box = await this.boxService.create(createBoxDto, organization)
    if (box.state !== BoxState.STARTED) {
      box = await this.boxStateWaiter.waitForStarted(box.id, organization.id, 30)
    }
    return boxToBoxResponse(box)
  }

  /**
   * Fail-closed create route for options that older API builds may not know.
   * Capability-aware clients use this path so a mixed-version deployment
   * returns 404 on an old instance instead of silently stripping cap fields.
   */
  @Post('strict')
  @HttpCode(201)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  @ApiResponse({
    status: 201,
    description: 'Box created with strict option handling',
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
        cpus: req.body?.cpus,
        memory_mib: req.body?.memory_mib,
        disk_size_gb: req.body?.disk_size_gb,
        working_dir: req.body?.working_dir,
        entrypoint: req.body?.entrypoint,
        cmd: req.body?.cmd,
        advanced: req.body?.advanced,
        detach: req.body?.detach,
        auto_pause: req.body?.auto_pause,
        auto_delete: req.body?.auto_delete,
        auto_resume: req.body?.auto_resume,
      }),
    },
  })
  async createBoxStrict(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateBoxDto,
  ): Promise<BoxResponseDto> {
    return this.createBoxWithOptions(authContext, dto)
  }

  @Post('get-or-create/strict')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  @ApiResponse({
    status: 200,
    description: 'Existing or newly created box',
    type: GetOrCreateBoxResponseDto,
  })
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.BOX,
    targetIdFromResult: (result: GetOrCreateBoxResponseDto) => result?.box_info?.box_id,
    requestMetadata: {
      body: (req: TypedRequest<CreateBoxDto>) => ({
        name: req.body?.name,
        image: req.body?.image,
        user: req.body?.user,
        env: req.body?.env
          ? Object.fromEntries(Object.keys(req.body?.env).map((key) => [key, MASKED_AUDIT_VALUE]))
          : undefined,
        cpus: req.body?.cpus,
        memory_mib: req.body?.memory_mib,
        disk_size_gb: req.body?.disk_size_gb,
        working_dir: req.body?.working_dir,
        entrypoint: req.body?.entrypoint,
        cmd: req.body?.cmd,
        advanced: req.body?.advanced,
        detach: req.body?.detach,
        auto_pause: req.body?.auto_pause,
        auto_delete: req.body?.auto_delete,
        auto_resume: req.body?.auto_resume,
      }),
    },
  })
  async getOrCreateBoxStrict(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateBoxDto,
  ): Promise<GetOrCreateBoxResponseDto> {
    const createBoxDto = createBoxToCreateBox(dto)
    const result = await this.boxService.getOrCreate(createBoxDto, authContext.organization)
    let box = result.box
    if (result.created && box.state !== BoxState.STARTED) {
      box = await this.boxStateWaiter.waitForStarted(box.id, authContext.organizationId, 30)
    }
    return {
      box_info: boxToBoxResponse(box),
      created: result.created,
    }
  }

  @Get(['', 'strict'])
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

  @Get([':boxId', ':boxId/strict'])
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
    const dto = await this.boxService.toBoxDto(box)
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
  @HttpCode(204)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
  })
  async removeBox(@AuthContext() authContext: OrganizationAuthContext, @Param('boxId') boxId: string) {
    await this.boxService.destroy(boxId, authContext.organizationId)
  }

  @Post(':boxId/start')
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
    const box = await this.boxService.stop(boxId, authContext.organizationId)
    const dto = await this.boxService.toBoxDto(box)
    return boxToBoxResponse(dto)
  }

  private isStartAlreadyInProgress(box: Box): boolean {
    return (
      box.desiredState === BoxDesiredState.STARTED &&
      [BoxState.UNKNOWN, BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING].includes(box.state)
    )
  }
}
