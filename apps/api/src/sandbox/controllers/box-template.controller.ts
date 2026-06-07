/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Next,
  NotFoundException,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Query,
  RawBodyRequest,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common'
import { IncomingMessage, ServerResponse } from 'http'
import { NextFunction } from 'express'
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOAuth2,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { UrlDto } from '../../common/dto/url.dto'
import { BoxTemplateDto } from '../dto/box-template.dto'
import { CreateBoxTemplateDto } from '../dto/create-box-template.dto'
import { PaginatedBoxTemplatesDto } from '../dto/paginated-box-templates.dto'
import { ListBoxTemplatesQueryDto } from '../dto/list-box-templates-query.dto'
import { SetBoxTemplateGeneralStatusDto } from '../dto/update-box-template.dto'
import { BoxTemplateAccessGuard } from '../guards/box-template-access.guard'
import { BoxTemplateReadAccessGuard } from '../guards/box-template-read-access.guard'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { LogProxy } from '../proxy/log-proxy'
import { BoxTemplateService } from '../services/box-template.service'
import { RunnerService } from '../services/runner.service'

@ApiTags('templates')
@ApiExtraModels(BoxTemplateDto, PaginatedBoxTemplatesDto)
@Controller('templates')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class BoxTemplateController {
  constructor(
    private readonly boxTemplateService: BoxTemplateService,
    private readonly runnerService: RunnerService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a new box template',
    operationId: 'createBoxTemplate',
  })
  @ApiResponse({
    status: 200,
    description: 'The box template has been successfully created.',
    type: BoxTemplateDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_TEMPLATES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.TEMPLATE,
    targetIdFromResult: (result: BoxTemplateDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateBoxTemplateDto>) => ({
        name: req.body?.name,
        imageName: req.body?.imageName,
        entrypoint: req.body?.entrypoint,
        general: req.body?.general,
        cpu: req.body?.cpu,
        memory: req.body?.memory,
        disk: req.body?.disk,
        gpu: req.body?.gpu,
        buildInfo: req.body?.buildInfo,
      }),
    },
  })
  async createBoxTemplate(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() createBoxTemplateDto: CreateBoxTemplateDto,
  ): Promise<BoxTemplateDto> {
    if (createBoxTemplateDto.general && authContext.role !== SystemRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions for creating general templates')
    }

    if (createBoxTemplateDto.buildInfo) {
      if (createBoxTemplateDto.imageName) {
        throw new BadRequestError('Cannot specify an image name when using a build info entry')
      }
      if (createBoxTemplateDto.entrypoint) {
        throw new BadRequestError('Cannot specify an entrypoint when using a build info entry')
      }
    } else if (!createBoxTemplateDto.imageName) {
      throw new BadRequestError('Must specify an image name when not using a build info entry')
    }

    const template = createBoxTemplateDto.buildInfo
      ? await this.boxTemplateService.createFromBuildInfo(authContext.organization, createBoxTemplateDto)
      : await this.boxTemplateService.createFromPull(authContext.organization, createBoxTemplateDto)

    return BoxTemplateDto.fromBoxTemplateEntity(template)
  }

  @Get()
  @ApiOperation({
    summary: 'List box templates',
    operationId: 'listBoxTemplates',
  })
  @ApiResponse({
    status: 200,
    description: 'Box templates available to the organization',
    schema: {
      oneOf: [
        { type: 'array', items: { $ref: getSchemaPath(BoxTemplateDto) } },
        { $ref: getSchemaPath(PaginatedBoxTemplatesDto) },
      ],
    },
  })
  async listBoxTemplates(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() queryParams: ListBoxTemplatesQueryDto,
    @Request() req: { query?: Record<string, unknown> },
  ): Promise<BoxTemplateDto[] | PaginatedBoxTemplatesDto> {
    const query = req.query ?? {}
    const hasPagination = ['page', 'limit', 'name', 'sort', 'order'].some((key) =>
      Object.prototype.hasOwnProperty.call(query, key),
    )

    if (!hasPagination) {
      const templates = await this.boxTemplateService.getSystemTemplates(authContext.organizationId)
      return templates.map(BoxTemplateDto.fromBoxTemplateEntity)
    }

    const { page, limit, name, sort, order } = queryParams
    const result = await this.boxTemplateService.getAllBoxTemplates(
      authContext.organizationId,
      page,
      limit,
      { name },
      { field: sort, direction: order },
    )

    return {
      items: result.items.map(BoxTemplateDto.fromBoxTemplateEntity),
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
    }
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get box template by ID or name',
    operationId: 'getBoxTemplate',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID or name',
  })
  @ApiResponse({
    status: 200,
    description: 'The box template',
    type: BoxTemplateDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  @UseGuards(BoxTemplateReadAccessGuard)
  async getBoxTemplate(
    @Param('id') templateIdOrName: string,
    @AuthContext() authContext: OrganizationAuthContext,
  ): Promise<BoxTemplateDto> {
    const template = await this.boxTemplateService.getBoxTemplateWithRegions(
      templateIdOrName,
      authContext.organizationId,
    )
    return BoxTemplateDto.fromBoxTemplateEntity(template)
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete box template',
    operationId: 'removeBoxTemplate',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Template has been deleted',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_TEMPLATES])
  @UseGuards(BoxTemplateAccessGuard)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.TEMPLATE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async removeBoxTemplate(@Param('id') templateId: string): Promise<void> {
    await this.boxTemplateService.removeBoxTemplate(templateId)
  }

  @Patch(':id/general')
  @ApiOperation({
    summary: 'Set box template general status',
    operationId: 'setBoxTemplateGeneralStatus',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Template general status has been set',
    type: BoxTemplateDto,
  })
  @Audit({
    action: AuditAction.SET_GENERAL_STATUS,
    targetType: AuditTarget.TEMPLATE,
    targetIdFromRequest: (req) => req.params.id,
    requestMetadata: {
      body: (req: TypedRequest<SetBoxTemplateGeneralStatusDto>) => ({
        general: req.body?.general,
      }),
    },
  })
  async setBoxTemplateGeneralStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('id') templateId: string,
    @Body() dto: SetBoxTemplateGeneralStatusDto,
  ): Promise<BoxTemplateDto> {
    if (authContext.role !== SystemRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions for changing template general status')
    }

    const template = await this.boxTemplateService.setBoxTemplateGeneralStatus(templateId, dto.general)
    return BoxTemplateDto.fromBoxTemplateEntity(template)
  }

  @Get(':id/build-logs')
  @ApiOperation({
    summary: 'Get box template build logs',
    operationId: 'getBoxTemplateBuildLogs',
    deprecated: true,
    description: 'This endpoint is deprecated. Use `getBoxTemplateBuildLogsUrl` instead.',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiQuery({
    name: 'follow',
    required: false,
    type: Boolean,
    description: 'Whether to follow the logs stream',
  })
  @UseGuards(BoxTemplateAccessGuard)
  async getBoxTemplateBuildLogs(
    @Request() req: RawBodyRequest<IncomingMessage>,
    @Res() res: ServerResponse<IncomingMessage>,
    @Next() next: NextFunction,
    @Param('id') templateId: string,
    @Query('follow', new ParseBoolPipe({ optional: true })) follow?: boolean,
  ): Promise<void> {
    let template = await this.boxTemplateService.getBoxTemplate(templateId)

    if (!template.buildInfo) {
      throw new NotFoundException(`Template ${templateId} has no build info`)
    }

    if (template.state == BoxTemplateState.ACTIVE) {
      res.end()
      return
    }

    const startTime = Date.now()
    const timeoutMs = 30 * 1000

    while (!template.initialRunnerId) {
      if (Date.now() - startTime > timeoutMs) {
        throw new NotFoundException(`Timeout waiting for build runner assignment for template ${templateId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      template = await this.boxTemplateService.getBoxTemplate(templateId)
    }

    const runner = await this.runnerService.findOneOrFail(template.initialRunnerId)

    if (!runner.apiUrl) {
      throw new NotFoundException(`Build runner for template ${templateId} has no API URL`)
    }

    const logProxy = new LogProxy(
      runner.apiUrl,
      template.buildInfo.artifactRef,
      runner.apiKey,
      follow === true,
      req,
      res,
      next,
    )
    return logProxy.create()
  }

  @Get(':id/build-logs-url')
  @ApiOperation({
    summary: 'Get box template build logs URL',
    operationId: 'getBoxTemplateBuildLogsUrl',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'The template build logs URL',
    type: UrlDto,
  })
  @UseGuards(BoxTemplateAccessGuard)
  async getBoxTemplateBuildLogsUrl(@Param('id') templateId: string): Promise<UrlDto> {
    let template = await this.boxTemplateService.getBoxTemplate(templateId)

    if (!template.buildInfo) {
      throw new NotFoundException(`Template ${templateId} has no build info`)
    }

    const startTime = Date.now()
    const timeoutMs = 30 * 1000

    while (!template.initialRunnerId) {
      if (Date.now() - startTime > timeoutMs) {
        throw new NotFoundException(`Timeout waiting for build runner assignment for template ${templateId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      template = await this.boxTemplateService.getBoxTemplate(templateId)
    }

    const url = await this.boxTemplateService.getBuildLogsUrl(template)
    return new UrlDto(url)
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Activate a box template',
    operationId: 'activateBoxTemplate',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'The template has been successfully activated.',
    type: BoxTemplateDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_TEMPLATES])
  @UseGuards(BoxTemplateAccessGuard)
  @Audit({
    action: AuditAction.ACTIVATE,
    targetType: AuditTarget.TEMPLATE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async activateBoxTemplate(
    @Param('id') templateId: string,
    @AuthContext() authContext: OrganizationAuthContext,
  ): Promise<BoxTemplateDto> {
    const template = await this.boxTemplateService.activateBoxTemplate(templateId, authContext.organization)
    return BoxTemplateDto.fromBoxTemplateEntity(template)
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a box template',
    operationId: 'deactivateBoxTemplate',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 204,
    description: 'The template has been successfully deactivated.',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_TEMPLATES])
  @UseGuards(BoxTemplateAccessGuard)
  @Audit({
    action: AuditAction.DEACTIVATE,
    targetType: AuditTarget.TEMPLATE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async deactivateBoxTemplate(@Param('id') templateId: string) {
    await this.boxTemplateService.deactivateBoxTemplate(templateId)
  }
}
