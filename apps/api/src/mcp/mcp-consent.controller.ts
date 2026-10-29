/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiExcludeController } from '@nestjs/swagger'
import { Request } from 'express'
import * as z from 'zod'
import { AuthContext } from '../common/interfaces/auth-context.interface'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { McpConsentService, MCP_SCOPES } from './mcp-consent.service'
import { McpGrantStore } from './mcp-grant.store'

const previewSchema = z.strictObject({ challenge: z.string().min(1).max(8192) })
const approvalSchema = previewSchema.extend({
  state: z.string().min(1).max(2048),
  organization_id: z.uuid(),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
})
type DashboardRequest = Request & { user: AuthContext }

@ApiExcludeController()
@Controller('mcp-consent')
@UseGuards(AuthGuard('jwt'), AuthenticatedRateLimitGuard)
export class McpConsentController {
  constructor(
    private readonly consent: McpConsentService,
    private readonly grants: McpGrantStore,
    private readonly config: TypedConfigService,
  ) {}

  @Post('preview')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  preview(@Req() request: DashboardRequest, @Body() body: unknown) {
    const input = previewSchema.safeParse(body)
    if (!input.success) throw new BadRequestException('Invalid consent request')
    return this.consent.preview(this.user(request), input.data.challenge)
  }

  @Post('approve')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  approve(@Req() request: DashboardRequest, @Body() body: unknown) {
    const input = approvalSchema.safeParse(body)
    if (!input.success) throw new BadRequestException('Invalid consent request')
    return this.consent.approve(
      this.user(request),
      input.data.challenge,
      input.data.state,
      input.data.organization_id,
      input.data.scopes,
    )
  }

  @Get('grants')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: DashboardRequest) {
    return this.grants.list(this.user(request))
  }

  @Delete('grants/:id')
  @Header('Cache-Control', 'no-store')
  revoke(@Req() request: DashboardRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.grants.revoke(this.user(request), id)
  }

  private user(request: DashboardRequest): string {
    if (request.user.role !== SystemRole.USER) throw new ForbiddenException('User sign-in required')
    const origin = request.get('origin')
    const consentUrl = this.config.get('mcp.consentUrl')
    // Bearer-only auth and a fixed browser origin protect grant mutations from CSRF.
    if (!consentUrl || (request.method !== 'GET' && origin !== new URL(consentUrl).origin))
      throw new ForbiddenException('Invalid consent origin')
    return request.user.userId
  }
}
