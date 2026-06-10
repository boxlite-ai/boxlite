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
  ParseBoolPipe,
} from '@nestjs/common'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { BoxService } from '../services/box.service'
import { CreateBoxDto } from '../dto/create-box.dto'
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
import { BoxDto, BoxLabelsDto } from '../dto/box.dto'
import { ResizeBoxDto } from '../dto/resize-box.dto'
import { UpdateBoxStateDto } from '../dto/update-box-state.dto'
import { PaginatedBoxesDto } from '../dto/paginated-boxes.dto'
import { RunnerService } from '../services/runner.service'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { BoxState } from '../enums/box-state.enum'
import { Box } from '../entities/box.entity'
import { ContentTypeInterceptor } from '../../common/interceptors/content-type.interceptors'
import { BoxAccessGuard } from '../guards/box-access.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { PortPreviewUrlDto, SignedPortPreviewUrlDto } from '../dto/port-preview-url.dto'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { Audit, MASKED_AUDIT_VALUE, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
// import { UpdateBoxNetworkSettingsDto } from '../dto/update-box-network-settings.dto'
import { SshAccessDto, SshAccessValidationDto } from '../dto/ssh-access.dto'
import { ListBoxesQueryDto } from '../dto/list-boxes-query.dto'
import { ProxyGuard } from '../guards/proxy.guard'
import { OrGuard } from '../../auth/or.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { SkipThrottle } from '@nestjs/throttler'
import { ThrottlerScope } from '../../common/decorators/throttler-scope.decorator'
import { SshGatewayGuard } from '../guards/ssh-gateway.guard'
import { ToolboxProxyUrlDto } from '../dto/toolbox-proxy-url.dto'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { BOX_EVENT_CHANNEL } from '../../common/constants/constants'
import { RequireFlagsEnabled } from '@openfeature/nestjs-sdk'
import { FeatureFlags } from '../../common/constants/feature-flags'
import { RegionBoxAccessGuard } from '../guards/region-box-access.guard'

@ApiTags('box')
@Controller('box')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class BoxController {
  private readonly logger = new Logger(BoxController.name)
  private readonly boxCallbacks: Map<string, (event: BoxStateUpdatedEvent) => void> = new Map()
  private readonly redisSubscriber: Redis
  constructor(
    private readonly runnerService: RunnerService,
    private readonly boxService: BoxService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.redisSubscriber = this.redis.duplicate()
    this.redisSubscriber.subscribe(BOX_EVENT_CHANNEL)
    this.redisSubscriber.on('message', (channel, message) => {
      if (channel !== BOX_EVENT_CHANNEL) {
        return
      }

      try {
        const event = JSON.parse(message) as BoxStateUpdatedEvent
        this.handleBoxStateUpdated(event)
      } catch (error) {
        this.logger.error('Failed to parse box state updated event:', error)
        return
      }
    })
  }

  @Get()
  @ApiOperation({
    summary: 'List all boxes',
    operationId: 'listBoxes',
  })
  @ApiResponse({
    status: 200,
    description: 'List of all boxes',
    type: [BoxDto],
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
  @ApiQuery({
    name: 'includeErroredDeleted',
    required: false,
    type: Boolean,
    description: 'Include errored and deleted boxes',
  })
  async listBoxes(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query('verbose') verbose?: boolean,
    @Query('labels') labelsQuery?: string,
    @Query('includeErroredDeleted') includeErroredDeleted?: boolean,
  ): Promise<BoxDto[]> {
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined
    const boxes = await this.boxService.findAllDeprecated(authContext.organizationId, labels, includeErroredDeleted)

    return this.boxService.toBoxDtos(boxes)
  }

  @Get('paginated')
  @ApiOperation({
    summary: 'List all boxes paginated',
    operationId: 'listBoxesPaginated',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of all boxes',
    type: PaginatedBoxesDto,
  })
  async listBoxesPaginated(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() queryParams: ListBoxesQueryDto,
  ): Promise<PaginatedBoxesDto> {
    const {
      page,
      limit,
      id,
      name,
      labels,
      includeErroredDeleted: includeErroredDestroyed,
      states,
      regions,
      minCpu,
      maxCpu,
      minMemoryGiB,
      maxMemoryGiB,
      minDiskGiB,
      maxDiskGiB,
      lastEventAfter,
      lastEventBefore,
      sort: sortField,
      order: sortDirection,
    } = queryParams

    const result = await this.boxService.findAll(
      authContext.organizationId,
      page,
      limit,
      {
        id,
        name,
        labels: labels ? JSON.parse(labels) : undefined,
        includeErroredDestroyed,
        states,
        regionIds: regions,
        minCpu,
        maxCpu,
        minMemoryGiB,
        maxMemoryGiB,
        minDiskGiB,
        maxDiskGiB,
        lastEventAfter,
        lastEventBefore,
      },
      {
        field: sortField,
        direction: sortDirection,
      },
    )

    return {
      items: await this.boxService.toBoxDtos(result.items),
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
    }
  }

  @Post()
  @HttpCode(200) //  for BoxLite Api compatibility
  @UseInterceptors(ContentTypeInterceptor)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-create')
  @ApiOperation({
    summary: 'Create a new box',
    operationId: 'createBox',
  })
  @ApiResponse({
    status: 200,
    description: 'The box has been successfully created.',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.BOX,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateBoxDto>) => ({
        name: req.body?.name,
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
        autoDeleteInterval: req.body?.autoDeleteInterval,
        volumes: req.body?.volumes,
        networkBlockAll: req.body?.networkBlockAll,
        networkAllowList: req.body?.networkAllowList,
      }),
    },
  })
  async createBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() createBoxDto: CreateBoxDto,
  ): Promise<BoxDto> {
    const organization = authContext.organization
    let box: BoxDto

    box = await this.boxService.createFromTemplate(createBoxDto, organization)
    if (box.state === BoxState.STARTED) {
      return box
    }

    await this.waitForBoxStarted(box, 30)

    return box
  }

  @Get('for-runner')
  @UseGuards(RunnerAuthGuard)
  @ApiOperation({
    summary: 'Get boxes for the authenticated runner',
    operationId: 'getBoxesForRunner',
  })
  @ApiQuery({
    name: 'states',
    required: false,
    type: String,
    description: 'Comma-separated list of box states to filter by',
  })
  @ApiQuery({
    name: 'skipReconcilingBoxes',
    required: false,
    type: Boolean,
    description: 'Skip boxes where state differs from desired state',
  })
  @ApiResponse({
    status: 200,
    description: 'List of boxes for the authenticated runner',
    type: [BoxDto],
  })
  async getBoxesForRunner(
    @RunnerContextDecorator() runnerContext: RunnerContext,
    @Query('states') states?: string,
    @Query('skipReconcilingBoxes') skipReconcilingBoxes?: string,
  ): Promise<BoxDto[]> {
    const stateArray = states
      ? states.split(',').map((s) => {
          if (!Object.values(BoxState).includes(s as BoxState)) {
            throw new BadRequestError(`Invalid box state: ${s}`)
          }
          return s as BoxState
        })
      : undefined

    const skip = skipReconcilingBoxes === 'true'
    const boxes = await this.boxService.findByRunnerId(runnerContext.runnerId, stateArray, skip)

    return this.boxService.toBoxDtos(boxes)
  }

  @Get(':boxIdOrName')
  @ApiOperation({
    summary: 'Get box details',
    operationId: 'getBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
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
    description: 'Box details',
    type: BoxDto,
  })
  @UseGuards(BoxAccessGuard)
  async getBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Query('verbose') verbose?: boolean,
  ): Promise<BoxDto> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, authContext.organizationId)

    return this.boxService.toBoxDto(box)
  }

  @Delete(':boxIdOrName')
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-lifecycle')
  @ApiOperation({
    summary: 'Delete box',
    operationId: 'deleteBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Box has been deleted',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
  })
  async deleteBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
  ): Promise<BoxDto> {
    const box = await this.boxService.destroy(boxIdOrName, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  @Post(':boxIdOrName/recover')
  @HttpCode(200)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-lifecycle')
  @ApiOperation({
    summary: 'Recover box from error state',
    operationId: 'recoverBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery initiated',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.RECOVER,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
  })
  async recoverBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
  ): Promise<BoxDto> {
    const recoveredBox = await this.boxService.recover(boxIdOrName, authContext.organization)
    let boxDto = await this.boxService.toBoxDto(recoveredBox)

    if (boxDto.state !== BoxState.STARTED) {
      boxDto = await this.waitForBoxStarted(boxDto, 30)
    }

    return boxDto
  }

  @Post(':boxIdOrName/start')
  @HttpCode(200)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-lifecycle')
  @ApiOperation({
    summary: 'Start box',
    operationId: 'startBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Box has been started',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.START,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
  })
  async startBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
  ): Promise<BoxDto> {
    const sbx = await this.boxService.start(boxIdOrName, authContext.organization)
    let box = await this.boxService.toBoxDto(sbx)

    if (![BoxState.RESTORING, BoxState.STARTED].includes(box.state)) {
      box = await this.waitForBoxStarted(box, 30)
    }

    return box
  }

  @Post(':boxIdOrName/stop')
  @HttpCode(200) //  for BoxLite Api compatibility
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-lifecycle')
  @ApiOperation({
    summary: 'Stop box',
    operationId: 'stopBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: 'boolean',
    description: 'Force stop the box using SIGKILL instead of SIGTERM',
  })
  @ApiResponse({
    status: 200,
    description: 'Box has been stopped',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.STOP,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      query: (req) => ({
        force: req.query?.force === 'true',
      }),
    },
  })
  async stopBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ): Promise<BoxDto> {
    const box = await this.boxService.stop(boxIdOrName, authContext.organizationId, force)
    return this.boxService.toBoxDto(box)
  }

  @Post(':boxIdOrName/resize')
  @HttpCode(200)
  @UseInterceptors(ContentTypeInterceptor)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('box-lifecycle')
  @ApiOperation({
    summary: 'Resize box resources',
    operationId: 'resizeBox',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Box has been resized',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @RequireFlagsEnabled({ flags: [{ flagKey: FeatureFlags.BOX_RESIZE, defaultValue: false }] })
  @Audit({
    action: AuditAction.RESIZE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<ResizeBoxDto>) => ({
        cpu: req.body?.cpu,
        memory: req.body?.memory,
        disk: req.body?.disk,
      }),
    },
  })
  async resizeBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Body() resizeBoxDto: ResizeBoxDto,
  ): Promise<BoxDto> {
    const box = await this.boxService.resize(boxIdOrName, resizeBoxDto, authContext.organization)
    return this.boxService.toBoxDto(box)
  }

  @Put(':boxIdOrName/labels')
  @UseInterceptors(ContentTypeInterceptor)
  @ApiOperation({
    summary: 'Replace box labels',
    operationId: 'replaceLabels',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Labels have been successfully replaced',
    type: BoxLabelsDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.REPLACE_LABELS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<BoxLabelsDto>) => ({
        labels: req.body?.labels,
      }),
    },
  })
  async replaceLabels(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Body() labelsDto: BoxLabelsDto,
  ): Promise<BoxDto> {
    const box = await this.boxService.replaceLabels(boxIdOrName, labelsDto.labels, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  @Put(':boxId/state')
  @UseInterceptors(ContentTypeInterceptor)
  @ApiOperation({
    summary: 'Update box state',
    operationId: 'updateBoxState',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Box state has been successfully updated',
  })
  @UseGuards(RunnerAuthGuard)
  @UseGuards(BoxAccessGuard)
  async updateBoxState(@Param('boxId') boxId: string, @Body() updateStateDto: UpdateBoxStateDto): Promise<void> {
    await this.boxService.updateState(
      boxId,
      updateStateDto.state,
      updateStateDto.recoverable,
      updateStateDto.errorReason,
    )
  }

  @Post(':boxIdOrName/public/:isPublic')
  @ApiOperation({
    summary: 'Update public status',
    operationId: 'updatePublicStatus',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'isPublic',
    description: 'Public status to set',
    type: 'boolean',
  })
  @ApiResponse({
    status: 200,
    description: 'Public status has been successfully updated',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.UPDATE_PUBLIC_STATUS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      params: (req) => ({
        isPublic: req.params.isPublic,
      }),
    },
  })
  async updatePublicStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('isPublic') isPublic: boolean,
  ): Promise<BoxDto> {
    const box = await this.boxService.updatePublicStatus(boxIdOrName, isPublic, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  @Post(':boxId/last-activity')
  @ApiOperation({
    summary: 'Update box last activity',
    operationId: 'updateLastActivity',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Last activity has been updated',
  })
  @UseGuards(OrGuard([BoxAccessGuard, ProxyGuard, SshGatewayGuard, RegionBoxAccessGuard]))
  async updateLastActivity(@Param('boxId') boxId: string): Promise<void> {
    await this.boxService.updateLastActivityAt(boxId, new Date())
  }

  @Post(':boxIdOrName/autostop/:interval')
  @ApiOperation({
    summary: 'Set box auto-stop interval',
    operationId: 'setAutostopInterval',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
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
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.SET_AUTO_STOP_INTERVAL,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      params: (req) => ({
        interval: req.params.interval,
      }),
    },
  })
  async setAutostopInterval(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('interval') interval: number,
  ): Promise<BoxDto> {
    const box = await this.boxService.setAutostopInterval(boxIdOrName, interval, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  @Post(':boxIdOrName/autodelete/:interval')
  @ApiOperation({
    summary: 'Set box auto-delete interval',
    operationId: 'setAutoDeleteInterval',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'interval',
    description:
      'Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping)',
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Auto-delete interval has been set',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.SET_AUTO_DELETE_INTERVAL,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      params: (req) => ({
        interval: req.params.interval,
      }),
    },
  })
  async setAutoDeleteInterval(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('interval') interval: number,
  ): Promise<BoxDto> {
    const box = await this.boxService.setAutoDeleteInterval(boxIdOrName, interval, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  // TODO: Network settings endpoint will not be enabled for now
  // @Post(':boxIdOrName/network-settings')
  // @ApiOperation({
  //   summary: 'Update box network settings',
  //   operationId: 'updateNetworkSettings',
  // })
  // @ApiParam({
  //   name: 'boxIdOrName',
  //   description: 'ID or name of the box',
  //   type: 'string',
  // })
  // @ApiResponse({
  //   status: 200,
  //   description: 'Network settings have been updated',
  //   type: BoxDto,
  // })
  // @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  // @UseGuards(BoxAccessGuard)
  // @Audit({
  //   action: AuditAction.UPDATE_NETWORK_SETTINGS,
  //   targetType: AuditTarget.BOX,
  //   targetIdFromRequest: (req) => req.params.boxIdOrName,
  //   targetIdFromResult: (result: BoxDto) => result?.id,
  //   requestMetadata: {
  //     body: (req: TypedRequest<UpdateBoxNetworkSettingsDto>) => ({
  //       networkBlockAll: req.body?.networkBlockAll,
  //       networkAllowList: req.body?.networkAllowList,
  //     }),
  //   },
  // })
  // async updateNetworkSettings(
  //   @AuthContext() authContext: OrganizationAuthContext,
  //   @Param('boxIdOrName') boxIdOrName: string,
  //   @Body() networkSettings: UpdateBoxNetworkSettingsDto,
  // ): Promise<BoxDto> {
  //   const box = await this.boxService.updateNetworkSettings(
  //     boxIdOrName,
  //     networkSettings.networkBlockAll,
  //     networkSettings.networkAllowList,
  //     authContext.organizationId,
  //   )
  //   return BoxDto.fromBox(box, '')
  // }

  @Get(':boxIdOrName/ports/:port/preview-url')
  @ApiOperation({
    summary: 'Get preview URL for a box port',
    operationId: 'getPortPreviewUrl',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
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
    type: PortPreviewUrlDto,
  })
  @UseGuards(BoxAccessGuard)
  async getPortPreviewUrl(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('port') port: number,
  ): Promise<PortPreviewUrlDto> {
    return this.boxService.getPortPreviewUrl(boxIdOrName, authContext.organizationId, port)
  }

  @Get(':boxIdOrName/ports/:port/signed-preview-url')
  @ApiOperation({
    summary: 'Get signed preview URL for a box port',
    operationId: 'getSignedPortPreviewUrl',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'port',
    description: 'Port number to get signed preview URL for',
    type: 'integer',
  })
  @ApiQuery({
    name: 'expiresInSeconds',
    required: false,
    type: 'integer',
    description: 'Expiration time in seconds (default: 60 seconds)',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed preview URL for the specified port',
    type: SignedPortPreviewUrlDto,
  })
  @UseGuards(BoxAccessGuard)
  async getSignedPortPreviewUrl(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('port') port: number,
    @Query('expiresInSeconds') expiresInSeconds?: number,
  ): Promise<SignedPortPreviewUrlDto> {
    return this.boxService.getSignedPortPreviewUrl(boxIdOrName, authContext.organizationId, port, expiresInSeconds)
  }

  @Post(':boxIdOrName/ports/:port/signed-preview-url/:token/expire')
  @ApiOperation({
    summary: 'Expire signed preview URL for a box port',
    operationId: 'expireSignedPortPreviewUrl',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'port',
    description: 'Port number to expire signed preview URL for',
    type: 'integer',
  })
  @ApiParam({
    name: 'token',
    description: 'Token to expire signed preview URL for',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed preview URL has been expired',
  })
  @UseGuards(BoxAccessGuard)
  async expireSignedPortPreviewUrl(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('port') port: number,
    @Param('token') token: string,
  ): Promise<void> {
    await this.boxService.expireSignedPreviewUrlToken(boxIdOrName, authContext.organizationId, token, port)
  }

  @Post(':boxIdOrName/ssh-access')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create SSH access for box',
    operationId: 'createSshAccess',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiQuery({
    name: 'expiresInMinutes',
    required: false,
    type: Number,
    description: 'Expiration time in minutes (default: 60)',
  })
  @ApiResponse({
    status: 200,
    description: 'SSH access has been created',
    type: SshAccessDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.CREATE_SSH_ACCESS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: SshAccessDto) => result?.boxId,
    requestMetadata: {
      query: (req) => ({
        expiresInMinutes: req.query.expiresInMinutes,
      }),
    },
  })
  async createSshAccess(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Query('expiresInMinutes') expiresInMinutes?: number,
  ): Promise<SshAccessDto> {
    return await this.boxService.createSshAccess(boxIdOrName, expiresInMinutes, authContext.organizationId)
  }

  @Delete(':boxIdOrName/ssh-access')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke SSH access for box',
    operationId: 'revokeSshAccess',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiQuery({
    name: 'token',
    required: false,
    type: String,
    description: 'SSH access token to revoke. If not provided, all SSH access for the box will be revoked.',
  })
  @ApiResponse({
    status: 200,
    description: 'SSH access has been revoked',
    type: BoxDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.REVOKE_SSH_ACCESS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxDto) => result?.id,
    requestMetadata: {
      query: (req) => ({
        token: req.query.token,
      }),
    },
  })
  async revokeSshAccess(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Query('token') token?: string,
  ): Promise<BoxDto> {
    const box = await this.boxService.revokeSshAccess(boxIdOrName, token, authContext.organizationId)
    return this.boxService.toBoxDto(box)
  }

  @Get('ssh-access/validate')
  @ApiOperation({
    summary: 'Validate SSH access for box',
    operationId: 'validateSshAccess',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    type: String,
    description: 'SSH access token to validate',
  })
  @ApiResponse({
    status: 200,
    description: 'SSH access validation result',
    type: SshAccessValidationDto,
  })
  async validateSshAccess(@Query('token') token: string): Promise<SshAccessValidationDto> {
    const result = await this.boxService.validateSshAccess(token)
    return SshAccessValidationDto.fromValidationResult(result.valid, result.boxId)
  }

  @Get(':boxId/toolbox-proxy-url')
  @ApiOperation({
    summary: 'Get toolbox proxy URL for a box',
    operationId: 'getToolboxProxyUrl',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Toolbox proxy URL for the specified box',
    type: ToolboxProxyUrlDto,
  })
  @UseGuards(BoxAccessGuard)
  async getToolboxProxyUrl(@Param('boxId') boxId: string): Promise<ToolboxProxyUrlDto> {
    const url = await this.boxService.getToolboxProxyUrl(boxId)
    return new ToolboxProxyUrlDto(url)
  }

  // wait up to `timeoutSeconds` for the box to start; if it doesn’t, return current box
  private async waitForBoxStarted(box: BoxDto, timeoutSeconds: number): Promise<BoxDto> {
    let latestBox: Box
    const waitForStarted = new Promise<BoxDto>((resolve, reject) => {
      let timeout: NodeJS.Timeout
      const handleStateUpdated = (event: BoxStateUpdatedEvent) => {
        if (event.box.id !== box.id) {
          return
        }
        latestBox = event.box
        if (event.box.state === BoxState.STARTED) {
          this.boxCallbacks.delete(box.id)
          clearTimeout(timeout)
          resolve(this.boxService.toBoxDto(event.box))
        }
        if (event.box.state === BoxState.ERROR) {
          this.boxCallbacks.delete(box.id)
          clearTimeout(timeout)
          reject(new BadRequestError(`Box failed to start: ${event.box.errorReason}`))
        }
      }

      this.boxCallbacks.set(box.id, handleStateUpdated)

      timeout = setTimeout(() => {
        this.boxCallbacks.delete(box.id)
        if (latestBox) {
          resolve(this.boxService.toBoxDto(latestBox))
        } else {
          resolve(box)
        }
      }, timeoutSeconds * 1000)
    })

    return waitForStarted
  }

  private handleBoxStateUpdated(event: BoxStateUpdatedEvent) {
    const callback = this.boxCallbacks.get(event.box.id)
    if (callback) {
      callback(event)
    }
  }
}
