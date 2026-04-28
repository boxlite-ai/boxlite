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
  Param,
  Query,
  HttpCode,
  UseGuards,
  Logger,
  NotFoundException,
  Res,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { SandboxService } from '../sandbox/services/sandbox.service'
import { BoxResponseDto, ListBoxesResponseDto } from './dto/box-response.dto'
import { CreateBoxDto } from './dto/create-box.dto'
import { sandboxToBoxResponse, createBoxToCreateSandbox } from './mappers/sandbox-to-box.mapper'

@ApiTags('BoxLite REST')
@Controller('v1/:prefix/boxes')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteBoxController {
  private readonly logger = new Logger(BoxliteBoxController.name)

  constructor(private readonly sandboxService: SandboxService) {}

  @Post()
  @HttpCode(201)
  async createBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateBoxDto,
  ): Promise<BoxResponseDto> {
    const organization = authContext.organization
    const createSandboxDto = createBoxToCreateSandbox(dto)
    const sandbox = await this.sandboxService.createFromSnapshot(createSandboxDto, organization)
    return sandboxToBoxResponse(sandbox)
  }

  @Get()
  async listBoxes(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query('pageSize') pageSize?: string,
  ): Promise<ListBoxesResponseDto> {
    const sandboxes = await this.sandboxService.findAllDeprecated(authContext.organizationId)
    const dtos = await this.sandboxService.toSandboxDtos(sandboxes)
    return {
      boxes: dtos.map(sandboxToBoxResponse),
    }
  }

  @Get(':boxId')
  async getBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    const sandbox = await this.sandboxService.findOneByIdOrName(boxId, authContext.organizationId)
    const dto = await this.sandboxService.toSandboxDto(sandbox)
    return sandboxToBoxResponse(dto)
  }

  @Head(':boxId')
  async headBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Res() res: Response,
  ) {
    try {
      await this.sandboxService.findOneByIdOrName(boxId, authContext.organizationId)
      res.status(204).end()
    } catch {
      res.status(404).end()
    }
  }

  @Delete(':boxId')
  @HttpCode(204)
  async removeBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ) {
    await this.sandboxService.destroy(boxId, authContext.organizationId)
  }

  @Post(':boxId/start')
  async startBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    const sandbox = await this.sandboxService.start(boxId, authContext.organization)
    const dto = await this.sandboxService.toSandboxDto(sandbox)
    return sandboxToBoxResponse(dto)
  }

  @Post(':boxId/stop')
  async stopBox(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<BoxResponseDto> {
    const sandbox = await this.sandboxService.stop(boxId, authContext.organizationId)
    const dto = await this.sandboxService.toSandboxDto(sandbox)
    return sandboxToBoxResponse(dto)
  }
}
