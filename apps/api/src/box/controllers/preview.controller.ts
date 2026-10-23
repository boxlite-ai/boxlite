/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Redis from 'ioredis'
import {
  Controller,
  Get,
  Post,
  Param,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UseGuards,
  Req,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Body,
  Header,
  ValidationPipe,
} from '@nestjs/common'
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
import { OrganizationService } from '../../organization/services/organization.service'
import { AUTO_RESUMABLE_STATES, BoxAutoResumeService } from '../services/box-auto-resume.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { NetworkMode } from '../enums/network-mode.enum'
import { Request } from 'express'
import { AuthContextType, isAuthContext } from '../../common/interfaces/auth-context.interface'
import { TunnelAccessDto, TunnelHandoffDto } from '../dto/tunnel.dto'
import { UserService } from '../../user/user.service'

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
    private readonly organizationService: OrganizationService,
    private readonly autoResume: BoxAutoResumeService,
    private readonly users: UserService,
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

  @Post(':boxId/tunnels/:port/access')
  @ApiExcludeEndpoint()
  @UseGuards(CombinedAuthGuard, ProxyGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async tunnelAccess(
    @Param('boxId') boxId: string,
    @Param('port', ParseIntPipe) port: number,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) options: TunnelAccessDto = {},
  ) {
    if (options.userId !== undefined) {
      const user = await this.users.findOne(options.userId)
      if (!user) throw new NotFoundException('User not found')
      await this.hasBoxAccess({ user: { userId: user.id, role: user.role } } as never, boxId)
    }
    return this.tunnelService.access(boxId, port, options.token)
  }

  @Get(':boxId/tunnels/:port/session')
  @ApiExcludeEndpoint()
  @UseGuards(CombinedAuthGuard)
  @Header('Cache-Control', 'no-store')
  async tunnelSession(@Req() req: Request, @Param('boxId') boxId: string, @Param('port', ParseIntPipe) port: number) {
    await this.hasBoxAccess(req, boxId)
    const subject = (req as Request & { user: AuthContextType }).user
    if (!isAuthContext(subject) || subject.apiKey) throw new BadRequestException('Browser login requires a user JWT')
    return { grant: await this.tunnelService.access(boxId, port), userId: subject.userId }
  }

  @Post('tunnel-handoff')
  @ApiExcludeEndpoint()
  @UseGuards(CombinedAuthGuard, ProxyGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async tunnelHandoff(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) options: TunnelHandoffDto,
  ) {
    if (options.grant && !options.ticket) return { ticket: await this.tunnelService.issueHandoff(options.grant) }
    if (options.ticket && !options.grant) return { grant: await this.tunnelService.consumeHandoff(options.ticket) }
    throw new BadRequestException('Expected a grant or ticket')
  }

  // The preview proxy calls this when the runner refuses a guest-port dial
  // because the box is not running. It takes the same steps as SDK exec's
  // auto-resume in BoxliteProxyController.proxyToRunner, so preview and SDK
  // traffic share one policy, one lock and one start. The proxy has no
  // organization identity, so the organization comes from the box row.
  @Post(':boxId/ensure-ready')
  @ApiExcludeEndpoint()
  @UseGuards(CombinedAuthGuard, ProxyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async ensureReady(@Param('boxId') boxId: string): Promise<void> {
    const box = await this.boxService.findOne(boxId)
    const organization = await this.organizationService.findOne(box.organizationId)
    if (!organization) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    if (!box.autoResume) {
      // A box paused for a snapshot is STARTED and meant to stay so: the proxy
      // keeps polling until it thaws. Auto-resume boxes go on below.
      if (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) return
      throw new ConflictException(`Box ${boxId} has auto-resume disabled`)
    }
    // Refuse at once a state (archived, resizing, ...) that never reaches STARTED.
    if (box.state !== BoxState.STARTED && !AUTO_RESUMABLE_STATES.includes(box.state)) {
      throw new BadRequestException(`Box ${boxId} cannot be resumed (state: ${box.state})`)
    }

    // Activity first, so the AutoStop sweeper cannot reap the box being woken.
    await this.boxService
      .updateLastActivityAt(box.id, new Date())
      .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))
    await this.autoResume.ensureReady(box.id, organization)
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
    description:
      'Inbound mode of the box: `enabled` permits access subject to each tunnel policy; `disabled` rejects all callers',
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
    const subject = (req as Request & { user?: AuthContextType }).user
    const box = await this.boxService.findOne(boxId)
    if (!subject || !isAuthContext(subject) || (subject.apiKey && subject.organizationId !== box.organizationId)) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    // Reaching a tunnel needs membership only; declaring one needs write:boxes.
    // Not cached, so a removed member loses access on the next request.
    if (!(await this.organizationUserService.exists(box.organizationId, subject.userId))) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }
    return true
  }
}
