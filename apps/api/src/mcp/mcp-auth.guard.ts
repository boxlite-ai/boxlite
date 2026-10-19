/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { errors, type JWTPayload } from 'jose'
import { ExtractJwt } from 'passport-jwt'
import { JwtStrategy } from '../auth/jwt.strategy'
import { McpAuthMetadata } from './mcp-auth-metadata'

const extractBearerToken = ExtractJwt.fromAuthHeaderAsBearerToken()

/**
 * Admits only bearer tokens issued for the MCP endpoint itself.
 *
 * REST keeps the `jwt` strategy and the API's audience. Here a token must name
 * `MCP_RESOURCE_URL` as its audience (RFC 8707), so a dashboard token cannot call
 * MCP and an MCP token cannot call REST; until that URL is set, the API's audience
 * applies. The caller is mapped exactly as the `jwt` strategy maps it.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly jwtStrategy: JwtStrategy,
    private readonly metadata: McpAuthMetadata,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = extractBearerToken(request)
    if (!token) {
      throw new UnauthorizedException()
    }
    let payload: JWTPayload
    try {
      payload = await this.jwtStrategy.verifyToken(token, this.metadata.audience)
    } catch (error) {
      // A bad signature, issuer, audience, or expiry is a 401; anything else, such
      // as the unverified-email 403, keeps its own status.
      if (error instanceof errors.JOSEError) {
        throw new UnauthorizedException()
      }
      throw error
    }
    request.user = await this.jwtStrategy.validate(request, payload)
    return true
  }
}
