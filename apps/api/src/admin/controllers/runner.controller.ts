/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOAuth2,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { AdminCreateRunnerDto } from '../dto/create-runner.dto'
import { AdminRunnerDto } from '../dto/admin-runner.dto'
import { Audit, MASKED_AUDIT_VALUE, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { RegionService } from '../../region/services/region.service'
import { CreateRunnerResponseDto } from '../../box/dto/create-runner-response.dto'
import { RunnerDto } from '../../box/dto/runner.dto'
import { RunnerService } from '../../box/services/runner.service'
import { SystemRole } from '../../user/enums/system-role.enum'

@ApiTags('admin')
@Controller('admin/runners')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminRunnerController {
  constructor(
    private readonly runnerService: RunnerService,
    private readonly regionService: RegionService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create runner',
    operationId: 'adminCreateRunner',
  })
  @ApiResponse({
    status: 201,
    type: CreateRunnerResponseDto,
  })
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.RUNNER,
    targetIdFromResult: (result: RunnerDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<AdminCreateRunnerDto>) => ({
        domain: req.body?.domain,
        apiUrl: req.body?.apiUrl,
        proxyUrl: req.body?.proxyUrl,
        regionId: req.body?.regionId,
        name: req.body?.name,
        apiKey: MASKED_AUDIT_VALUE,
        apiVersion: req.body?.apiVersion,
      }),
    },
  })
  async create(@Body() createRunnerDto: AdminCreateRunnerDto): Promise<CreateRunnerResponseDto> {
    const region = await this.regionService.findOne(createRunnerDto.regionId)

    if (!region) {
      throw new NotFoundException('Region not found')
    }

    const { runner, apiKey } = await this.runnerService.create({
      domain: createRunnerDto.domain,
      apiUrl: createRunnerDto.apiUrl,
      proxyUrl: createRunnerDto.proxyUrl,
      regionId: createRunnerDto.regionId,
      name: createRunnerDto.name,
      apiKey: createRunnerDto.apiKey,
      apiVersion: createRunnerDto.apiVersion,
      cpu: createRunnerDto.cpu,
      memoryGiB: createRunnerDto.memoryGiB,
      diskGiB: createRunnerDto.diskGiB,
    })

    return CreateRunnerResponseDto.fromRunner(runner, apiKey)
  }

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get runner by ID',
    operationId: 'adminGetRunnerById',
  })
  @ApiResponse({
    status: 200,
    type: AdminRunnerDto,
  })
  @ApiParam({
    name: 'id',
    description: 'Runner ID',
    type: String,
  })
  async getRunnerById(@Param('id', ParseUUIDPipe) id: string): Promise<AdminRunnerDto> {
    return this.toAdminRunnerDto(await this.runnerService.findOneFullOrFail(id))
  }

  @Get(':id/protected-release')
  @ApiExcludeEndpoint()
  async verifyProtectedRelease(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('processId', new ParseUUIDPipe({ version: '4' })) processId: string,
    @Query('executableDigest') executableDigest: string,
  ): Promise<{ revision: string }> {
    if (typeof executableDigest !== 'string' || !/^[a-f0-9]{64}$/.test(executableDigest)) {
      throw new BadRequestException('Expected a Runner executable SHA-256')
    }
    const revision = process.env.K_REVISION
    if (!revision || !(await this.runnerService.verifyProtectedRelease(id, processId, executableDigest))) {
      throw new ServiceUnavailableException('Current Runner process has not passed protected release verification')
    }
    return { revision }
  }

  @Post('protected-release/standalone')
  @ApiExcludeEndpoint()
  @HttpCode(204)
  async claimStandaloneRunnerUpdate(
    @Body('claimId', new ParseUUIDPipe({ version: '4' })) claimId: string,
  ): Promise<void> {
    if (!(await this.runnerService.claimStandaloneRunnerUpdate(claimId))) {
      throw new ConflictException('Stage does not allow a standalone Runner update')
    }
  }

  @Get('protected-release/serving')
  @ApiExcludeEndpoint()
  async verifyServingProtectedRelease(): Promise<{ revision: string; databaseLogin: string }> {
    const revision = process.env.K_REVISION
    if (!revision) throw new ServiceUnavailableException('Cloud Run revision is unavailable')
    return { revision, databaseLogin: await this.runnerService.releaseDatabaseLogin() }
  }

  @Get('protected-release/serving/:boxId')
  @ApiExcludeEndpoint()
  async verifyServingRunnerCompletion(@Param('boxId') boxId: string) {
    const revision = process.env.K_REVISION
    if (!revision || !/^[A-Za-z0-9]{12}$/.test(boxId)) throw new BadRequestException('Invalid release Box or revision')
    const receipt = await this.runnerService.releaseOrdinaryCreateReceipt(boxId, revision)
    if (!receipt)
      throw new ServiceUnavailableException('The exact ordinary V2 create has no completion on this revision')
    return { revision, boxId, ...receipt }
  }

  @Delete('protected-release/standalone/:claimId')
  @ApiExcludeEndpoint()
  @HttpCode(204)
  async finishStandaloneRunnerUpdate(
    @Param('claimId', new ParseUUIDPipe({ version: '4' })) claimId: string,
  ): Promise<void> {
    if (!(await this.runnerService.finishStandaloneRunnerUpdate(claimId))) {
      throw new ConflictException('Standalone Runner update claim changed')
    }
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({
    summary: 'List all runners',
    operationId: 'adminListRunners',
  })
  @ApiResponse({
    status: 200,
    type: [AdminRunnerDto],
  })
  @ApiQuery({
    name: 'regionId',
    description: 'Filter runners by region ID',
    type: String,
    required: false,
  })
  async findAll(@Query('regionId') regionId?: string): Promise<AdminRunnerDto[]> {
    if (regionId) {
      return (await this.runnerService.findAllByRegionFull(regionId)).map((runner) => this.toAdminRunnerDto(runner))
    }
    return (await this.runnerService.findAllFull()).map((runner) => this.toAdminRunnerDto(runner))
  }

  @Patch(':id/scheduling')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Update runner scheduling status',
    operationId: 'adminUpdateRunnerScheduling',
  })
  @ApiResponse({
    status: 204,
  })
  @Audit({
    action: AuditAction.UPDATE_SCHEDULING,
    targetType: AuditTarget.RUNNER,
    targetIdFromRequest: (req) => req.params.id,
    requestMetadata: {
      body: (req: TypedRequest<{ unschedulable: boolean }>) => ({
        unschedulable: req.body?.unschedulable,
      }),
    },
  })
  async updateSchedulingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('unschedulable') unschedulable: boolean,
  ): Promise<void> {
    await this.runnerService.updateSchedulingStatus(id, unschedulable)
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete runner',
    operationId: 'adminDeleteRunner',
  })
  @ApiResponse({
    status: 204,
  })
  @ApiParam({
    name: 'id',
    description: 'Runner ID',
    type: String,
  })
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.RUNNER,
    targetIdFromRequest: (req) => req.params.id,
  })
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.runnerService.remove(id)
  }

  private toAdminRunnerDto(runner: AdminRunnerDto & { apiKey?: string }): AdminRunnerDto {
    const { apiKey: _apiKey, ...safeRunner } = runner
    return safeRunner
  }
}
