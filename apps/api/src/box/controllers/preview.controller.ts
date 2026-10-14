/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Redis from 'ioredis'
import { Controller, Get, Param, Logger, NotFoundException, UseGuards, Req, ParseIntPipe } from '@nestjs/common'
import { BoxService } from '../services/box.service'
import {
  ApiResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiOAuth2,
  ApiBearerAuth,
  ApiExcludeEndpoint,
} from '@nestjs/swagger'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { TunnelService } from '../services/tunnel.service'
import { ProxyGuard } from '../guards/proxy.guard'
import { NetworkMode } from '../enums/network-mode.enum'

const INBOUND_CACHE_TTL_SECONDS = 3
// Sentinel for "no such box", distinct from both modes.
const INBOUND_CACHE_MISSING = 'missing'

@ApiTags('preview')
@Controller('preview')
export class PreviewController {
  private readonly logger = new Logger(PreviewController.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly boxService: BoxService,
    private readonly organizationUserService: OrganizationUserService,
    private readonly tunnelService: TunnelService,
  ) {}

  @Get(':boxId/tunnels/:port')
  @ApiExcludeEndpoint()
  @UseGuards(CombinedAuthGuard, ProxyGuard)
  async isPublicTunnelActive(
    @Param('boxId') boxId: string,
    @Param('port', ParseIntPipe) port: number,
  ): Promise<boolean> {
    if (!(await this.tunnelService.isPublicAccessAllowed(boxId, port))) {
      throw new NotFoundException('Tunnel not found')
    }
    return true
  }

  @Get(':boxId/inbound')
  @ApiOperation({
    summary: 'Read the inbound mode of a box',
    operationId: 'getBoxInboundMode',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Inbound mode of the box: `enabled` means the proxy may serve its services without sign-in',
    schema: { type: 'string', enum: Object.values(NetworkMode) },
  })
  @UseGuards(CombinedAuthGuard, ProxyGuard)
  async getBoxInboundMode(@Param('boxId') boxId: string): Promise<NetworkMode> {
    return this.cachedInboundMode(boxId)
  }

  // 3-second cache: the proxy asks on every preview and tunnel request. A
  // missing box is cached too, so repeated probes do not reach the database.
  private async cachedInboundMode(boxId: string): Promise<NetworkMode> {
    const cacheKey = `preview:inbound:${boxId}`
    const cached = await this.redis.get(cacheKey)
    if (cached === INBOUND_CACHE_MISSING) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    if (cached) {
      return cached as NetworkMode
    }

    try {
      const mode = await this.boxService.getInboundMode(boxId)
      await this.redis.setex(cacheKey, INBOUND_CACHE_TTL_SECONDS, mode)
      return mode
    } catch (ex) {
      if (ex instanceof NotFoundException) {
        await this.redis.setex(cacheKey, INBOUND_CACHE_TTL_SECONDS, INBOUND_CACHE_MISSING)
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
}
