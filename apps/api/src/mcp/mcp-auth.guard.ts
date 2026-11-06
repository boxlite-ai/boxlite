/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { errors, type JWTPayload } from 'jose'
import { ExtractJwt } from 'passport-jwt'
import type { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JWT_REGEX } from '../auth/constants/jwt-regex.constant'
import { JwtStrategy } from '../auth/jwt.strategy'
import { isAuthContext, type AuthContext } from '../common/interfaces/auth-context.interface'
import type { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { grantedMcpScopes, setMcpOAuthScopes } from './mcp-oauth-policy'

const extractBearerToken = ExtractJwt.fromAuthHeaderAsBearerToken()

/**
 * Admits the two credentials hosted MCP servers commonly take: a user API key,
 * or an OAuth token issued for this endpoint.
 *
 * An OAuth token must name `MCP_RESOURCE_URL` as its audience (RFC 8707), so a
 * dashboard token cannot call MCP; until that URL is set the API's own audience
 * applies. API keys of machine principals (proxy, runner, collectors) are refused:
 * MCP tools act for a user. An API-key caller is mapped exactly as REST maps it.
 *
 * An OAuth caller becomes an API-key-shaped caller, so the REST guards apply
 * their API-key rules unchanged: its permissions are the token's MCP scopes held
 * by its role (owners hold all), its organization is the user's default one, read
 * on every request, and its system role is always `USER`, so no admin exemption
 * applies to a token.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly jwtStrategy: JwtStrategy,
    private readonly apiKeyStrategy: ApiKeyStrategy,
    private readonly metadata: McpAuthMetadata,
    private readonly organizationUsers: OrganizationUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = extractBearerToken(request)
    if (!token) {
      throw new UnauthorizedException()
    }
    request.user = JWT_REGEX.test(token) ? await this.fromOAuthToken(request, token) : await this.fromApiKey(token)
    return true
  }

  private async fromOAuthToken(request: Request, token: string) {
    let payload: JWTPayload
    try {
      payload = await this.jwtStrategy.verifyToken(token, this.metadata.audience)
    } catch (error) {
      // A bad signature, issuer, audience or expiry is a 401; anything else, such
      // as the unverified-email 403, keeps its own status.
      if (error instanceof errors.JOSEError) {
        throw new UnauthorizedException()
      }
      throw error
    }
    const user = await this.jwtStrategy.validate(request, payload)
    const membership = await this.organizationUsers.findDefault(user.userId)
    if (!membership) {
      throw new ForbiddenException('MCP sign-in needs a default organization')
    }
    const scopes = grantedMcpScopes(payload.scope)
    setMcpOAuthScopes(request, scopes)
    const apiKey = {
      organizationId: membership.organizationId,
      userId: user.userId,
      name: 'mcp-oauth',
      permissions: scopes.filter((scope) => membership.permissions.has(scope as OrganizationResourcePermission)),
    } as ApiKey
    const caller: AuthContext = {
      userId: user.userId,
      email: user.email,
      role: SystemRole.USER,
      organizationId: membership.organizationId,
      apiKey,
    }
    return caller
  }

  private async fromApiKey(token: string) {
    const caller = await this.apiKeyStrategy.validate(token)
    if (!caller || !isAuthContext(caller)) {
      throw new UnauthorizedException()
    }
    return caller
  }
}
