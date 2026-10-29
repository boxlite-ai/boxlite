/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { ExtractJwt } from 'passport-jwt'
import { CustomHeaders } from '../common/constants/header.constants'
import { McpAuthorizationService } from './mcp-authorization.service'

const extractBearerToken = ExtractJwt.fromAuthHeaderAsBearerToken()

/**
 * The credential selects exactly one organization. Tool arguments and headers
 * cannot switch it; the general Cloud guard's machine/admin bypass is absent.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly authorization: McpAuthorizationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = extractBearerToken(request)
    if (!token) {
      throw new UnauthorizedException()
    }
    if (request.get(CustomHeaders.ORGANIZATION_ID.name) !== undefined) {
      throw new UnauthorizedException('MCP organization overrides are not supported')
    }
    request.user = await this.authorization.authenticate(token)
    return true
  }
}
