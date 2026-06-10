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
  Body,
  Param,
  Query,
  Logger,
  UseGuards,
  HttpCode,
  UseInterceptors,
  Put,
  NotFoundException,
} from '@nestjs/common'
import Redis from 'ioredis'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { BoxService as WorkspaceService } from '../services/box.service'
import {
  ApiOAuth2,
  ApiResponse,
  ApiQuery,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiHeader,
  ApiBearerAuth,
} from '@nestjs/swagger'
import { BoxLabelsDto as WorkspaceLabelsDto } from '../dto/box.dto'
import { WorkspaceDto } from '../dto/workspace.deprecated.dto'
import { RunnerService } from '../services/runner.service'
import { BoxState as WorkspaceState } from '../enums/box-state.enum'
import { ContentTypeInterceptor } from '../../common/interceptors/content-type.interceptors'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { BoxAccessGuard as WorkspaceAccessGuard } from '../guards/box-access.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { WorkspacePortPreviewUrlDto } from '../dto/workspace-port-preview-url.deprecated.dto'
import { CreateWorkspaceDto } from '../dto/create-workspace.deprecated.dto'
import { TypedConfigService } from '../../config/typed-config.service'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Audit, MASKED_AUDIT_VALUE, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'

@ApiTags('workspace')
@Controller('workspace')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class WorkspaceController {
  private readonly logger = new Logger(WorkspaceController.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly runnerService: RunnerService,
    private readonly workspaceService: WorkspaceService,
    private readonly configService: TypedConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '[DEPRECATED] List all workspaces',
    operationId: 'listWorkspaces_deprecated',
    deprecated: true,
  })
  @ApiResponse({
    status: 200,
    description: 'List of all workspacees',
    type: [WorkspaceDto],
  })
  @ApiQuery({
    name: 'verbose',
    required: false,
    type: Boolean,
    description: 'Include verbose output',
  })
  @ApiQuery({
    name: 'labels',
    type: String,
    required: false,
    example: '{"label1": "value1", "label2": "value2"}',
    description: 'JSON encoded labels to filter by',
  })
  async listWorkspacees(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query('verbose') verbose?: boolean,
    @Query('labels') labelsQuery?: string,
  ): Promise<WorkspaceDto[]> {
    const labels = labelsQuery ? JSON.parse(labelsQuery) : {}
    const workspacees = await this.workspaceService.findAllDeprecated(authContext.organizationId, labels)
    const dtos = workspacees.map(async (workspace) => {
      const dto = WorkspaceDto.fromBox(workspace)
      return dto
    })
    return await Promise.all(dtos)
  }

  @Post()
  @HttpCode(200) //  for BoxLite Api compatibility
  @UseInterceptors(ContentTypeInterceptor)
  @ApiOperation({
    summary: '[DEPRECATED] Create a new workspace',
    operationId: 'createWorkspace_deprecated',
    deprecated: true,
  })
  @ApiResponse({
    status: 200,
    description: 'The workspace has been successfully created.',
    type: WorkspaceDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.BOX,
    targetIdFromResult: (result: WorkspaceDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateWorkspaceDto>) => ({
        image: req.body?.image,
        user: req.body?.user,
        env: req.body?.env
          ? Object.fromEntries(Object.keys(req.body?.env).map((key) => [key, MASKED_AUDIT_VALUE]))
          : undefined,
        labels: req.body?.labels,
        public: req.body?.public,
        class: req.body?.class,
        target: req.body?.target,
        cpu: req.body?.cpu,
        gpu: req.body?.gpu,
        memory: req.body?.memory,
        disk: req.body?.disk,
        autoStopInterval: req.body?.autoStopInterval,
        volumes: req.body?.volumes,
      }),
    },
  })
  async createWorkspace(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() createWorkspaceDto: CreateWorkspaceDto,
  ): Promise<WorkspaceDto> {
    const organization = authContext.organization

    const workspace = WorkspaceDto.fromBoxDto(
      await this.workspaceService.createFromTemplate(
        {
          ...createWorkspaceDto,
        },
        organization,
      ),
    )

    // Wait for the workspace to start
    const boxState = await this.waitForWorkspaceState(
      workspace.id,
      WorkspaceState.STARTED,
      30000, // 30 seconds timeout
    )
    workspace.state = boxState

    return workspace
  }

  @Get(':workspaceId')
  @ApiOperation({
    summary: '[DEPRECATED] Get workspace details',
    operationId: 'getWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiQuery({
    name: 'verbose',
    required: false,
    type: Boolean,
    description: 'Include verbose output',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace details',
    type: WorkspaceDto,
  })
  @UseGuards(WorkspaceAccessGuard)
  async getWorkspace(
    @Param('workspaceId') workspaceId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Query('verbose') verbose?: boolean,
  ): Promise<WorkspaceDto> {
    const workspace = await this.workspaceService.findOne(workspaceId, true)

    return WorkspaceDto.fromBox(workspace)
  }

  @Delete(':workspaceId')
  @ApiOperation({
    summary: '[DEPRECATED] Delete workspace',
    operationId: 'deleteWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace has been deleted',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
  })
  async removeWorkspace(
    @Param('workspaceId') workspaceId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Query('force') force?: boolean,
  ): Promise<void> {
    await this.workspaceService.destroy(workspaceId)
  }

  @Post(':workspaceId/start')
  @HttpCode(200)
  @ApiOperation({
    summary: '[DEPRECATED] Start workspace',
    operationId: 'startWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace has been started',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.START,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
  })
  async startWorkspace(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('workspaceId') workspaceId: string,
  ): Promise<void> {
    await this.workspaceService.start(workspaceId, authContext.organization)
  }

  @Post(':workspaceId/stop')
  @HttpCode(200) //  for BoxLite Api compatibility
  @ApiOperation({
    summary: '[DEPRECATED] Stop workspace',
    operationId: 'stopWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace has been stopped',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.STOP,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
  })
  async stopWorkspace(@Param('workspaceId') workspaceId: string): Promise<void> {
    await this.workspaceService.stop(workspaceId)
  }

  @Put(':workspaceId/labels')
  @UseInterceptors(ContentTypeInterceptor)
  @ApiOperation({
    summary: '[DEPRECATED] Replace workspace labels',
    operationId: 'replaceLabelsWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Labels have been successfully replaced',
    type: WorkspaceLabelsDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.REPLACE_LABELS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
    requestMetadata: {
      body: (req: TypedRequest<WorkspaceLabelsDto>) => ({
        labels: req.body?.labels,
      }),
    },
  })
  async replaceLabels(
    @Param('workspaceId') workspaceId: string,
    @Body() labelsDto: WorkspaceLabelsDto,
  ): Promise<WorkspaceLabelsDto> {
    const { labels } = await this.workspaceService.replaceLabels(workspaceId, labelsDto.labels)
    return { labels }
  }

  @Post(':workspaceId/public/:isPublic')
  @ApiOperation({
    summary: '[DEPRECATED] Update public status',
    operationId: 'updatePublicStatusWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiParam({
    name: 'isPublic',
    description: 'Public status to set',
    type: 'boolean',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.UPDATE_PUBLIC_STATUS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
    requestMetadata: {
      params: (req) => ({
        isPublic: req.params.isPublic,
      }),
    },
  })
  async updatePublicStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('isPublic') isPublic: boolean,
  ): Promise<void> {
    await this.workspaceService.updatePublicStatus(workspaceId, isPublic)
  }

  @Post(':workspaceId/autostop/:interval')
  @ApiOperation({
    summary: '[DEPRECATED] Set workspace auto-stop interval',
    operationId: 'setAutostopIntervalWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiParam({
    name: 'interval',
    description: 'Auto-stop interval in minutes (0 to disable)',
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Auto-stop interval has been set',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(WorkspaceAccessGuard)
  @Audit({
    action: AuditAction.SET_AUTO_STOP_INTERVAL,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.workspaceId,
    requestMetadata: {
      params: (req) => ({
        interval: req.params.interval,
      }),
    },
  })
  async setAutostopInterval(
    @Param('workspaceId') workspaceId: string,
    @Param('interval') interval: number,
  ): Promise<void> {
    await this.workspaceService.setAutostopInterval(workspaceId, interval)
  }

  @Get(':workspaceId/ports/:port/preview-url')
  @ApiOperation({
    summary: '[DEPRECATED] Get preview URL for a workspace port',
    operationId: 'getPortPreviewUrlWorkspace_deprecated',
    deprecated: true,
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'ID of the workspace',
    type: 'string',
  })
  @ApiParam({
    name: 'port',
    description: 'Port number to get preview URL for',
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Preview URL for the specified port',
    type: WorkspacePortPreviewUrlDto,
  })
  @UseGuards(WorkspaceAccessGuard)
  async getPortPreviewUrl(
    @Param('workspaceId') workspaceId: string,
    @Param('port') port: number,
  ): Promise<WorkspacePortPreviewUrlDto> {
    if (port < 1 || port > 65535) {
      throw new BadRequestError('Invalid port')
    }

    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    const proxyProtocol = this.configService.getOrThrow('proxy.protocol')
    const workspace = await this.workspaceService.findOne(workspaceId)
    if (!workspace) {
      throw new NotFoundException(`Workspace with ID ${workspaceId} not found`)
    }

    return {
      url: `${proxyProtocol}://${port}-${workspaceId}.${proxyDomain}`,
      token: workspace.authToken,
    }
  }

  private async waitForWorkspaceState(
    workspaceId: string,
    desiredState: WorkspaceState,
    timeout: number,
  ): Promise<WorkspaceState> {
    const startTime = Date.now()

    let workspaceState: WorkspaceState
    while (Date.now() - startTime < timeout) {
      const workspace = await this.workspaceService.findOne(workspaceId)
      workspaceState = workspace.state
      if (workspaceState === desiredState || workspaceState === WorkspaceState.ERROR) {
        return workspaceState
      }
      await new Promise((resolve) => setTimeout(resolve, 100)) // Wait 100 ms before checking again
    }

    return workspaceState
  }
}
