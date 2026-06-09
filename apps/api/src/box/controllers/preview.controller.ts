/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Redis from 'ioredis'
import { Controller, Get, Param, Logger, NotFoundException, UseGuards, Req } from '@nestjs/common'
import { BoxService } from '../services/box.service'
import { ApiResponse, ApiOperation, ApiParam, ApiTags, ApiOAuth2, ApiBearerAuth } from '@nestjs/swagger'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationUserService } from '../../organization/services/organization-user.service'

@ApiTags('preview')
@Controller('preview')
export class PreviewController {
  private readonly logger = new Logger(PreviewController.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly boxService: BoxService,
    private readonly organizationUserService: OrganizationUserService,
  ) {}

  @Get(':boxId/public')
  @ApiOperation({
    summary: 'Check if box is public',
    operationId: 'isBoxPublic',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Public status of the box',
    type: Boolean,
  })
  async isBoxPublic(@Param('boxId') boxId: string): Promise<boolean> {
    const cached = await this.redis.get(`preview:public:${boxId}`)
    if (cached) {
      if (cached === '1') {
        return true
      }
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    try {
      const isPublic = await this.boxService.isBoxPublic(boxId)
      //  for private boxes, throw 404 as well
      //  to prevent using the method to check if a box exists
      if (!isPublic) {
        //  cache the result for 3 seconds to avoid unnecessary requests to the database
        await this.redis.setex(`preview:public:${boxId}`, 3, '0')

        throw new NotFoundException(`Box with ID ${boxId} not found`)
      }
      //  cache the result for 3 seconds to avoid unnecessary requests to the database
      await this.redis.setex(`preview:public:${boxId}`, 3, '1')
      return true
    } catch (ex) {
      if (ex instanceof NotFoundException) {
        //  cache the not found box as well
        //  as it is the same case as for the private boxes
        await this.redis.setex(`preview:public:${boxId}`, 3, '0')
        throw ex
      }
      throw ex
    }
  }

  @Get(':boxId/validate/:authToken')
  @ApiOperation({
    summary: 'Check if box auth token is valid',
    operationId: 'isValidAuthToken',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'authToken',
    description: 'Auth token of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Box auth token validation status',
    type: Boolean,
  })
  async isValidAuthToken(@Param('boxId') boxId: string, @Param('authToken') authToken: string): Promise<boolean> {
    const cached = await this.redis.get(`preview:token:${boxId}:${authToken}`)
    if (cached) {
      if (cached === '1') {
        return true
      }
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    const box = await this.boxService.findOne(boxId)
    if (!box) {
      await this.redis.setex(`preview:token:${boxId}:${authToken}`, 3, '0')
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    if (box.authToken === authToken) {
      await this.redis.setex(`preview:token:${boxId}:${authToken}`, 3, '1')
      return true
    }
    await this.redis.setex(`preview:token:${boxId}:${authToken}`, 3, '0')
    throw new NotFoundException(`Box with ID ${boxId} not found`)
  }

  @Get(':boxId/access')
  @ApiOperation({
    summary: 'Check if user has access to the box',
    operationId: 'hasBoxAccess',
  })
  @ApiResponse({
    status: 200,
    description: 'User access status to the box',
    type: Boolean,
  })
  @UseGuards(CombinedAuthGuard)
  @ApiOAuth2(['openid', 'profile', 'email'])
  @ApiBearerAuth()
  async hasBoxAccess(@Req() req: Request, @Param('boxId') boxId: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const userId = req.user?.userId

    const cached = await this.redis.get(`preview:access:${boxId}:${userId}`)
    if (cached) {
      if (cached === '1') {
        return true
      }
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    const box = await this.boxService.findOne(boxId)
    const hasAccess = await this.organizationUserService.exists(box.organizationId, userId)
    if (!hasAccess) {
      await this.redis.setex(`preview:access:${boxId}:${userId}`, 3, '0')
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    //  if user has access, keep it in cache longer
    await this.redis.setex(`preview:access:${boxId}:${userId}`, 30, '1')
    return true
  }

  @Get(':signedPreviewToken/:port/box-id')
  @ApiOperation({
    summary: 'Get box ID from signed preview URL token',
    operationId: 'getBoxIdFromSignedPreviewUrlToken',
  })
  @ApiParam({
    name: 'signedPreviewToken',
    description: 'Signed preview URL token',
    type: 'string',
  })
  @ApiParam({
    name: 'port',
    description: 'Port number to get box ID from signed preview URL token',
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Box ID from signed preview URL token',
    type: String,
  })
  async getBoxIdFromSignedPreviewUrlToken(
    @Param('signedPreviewToken') signedPreviewToken: string,
    @Param('port') port: number,
  ): Promise<string> {
    return this.boxService.getBoxIdFromSignedPreviewUrlToken(signedPreviewToken, port)
  }
}
