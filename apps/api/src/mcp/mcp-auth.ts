/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { JwtStrategy } from '../auth/jwt.strategy'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { TypedConfigService } from '../config/typed-config.service'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'

export const MCP_METADATA_PATH = '.well-known/oauth-protected-resource/api/mcp'

@Injectable()
export class McpAuthMetadata {
  readonly resource?: string
  readonly url?: string

  constructor(
    config: TypedConfigService,
    private readonly jwt: JwtStrategy,
  ) {
    this.resource = config.get('mcp.resourceUrl')
    if (this.resource) this.url = new URL(`/${MCP_METADATA_PATH}`, this.resource).href
  }

  document() {
    return this.resource ? { resource: this.resource, authorization_servers: [this.jwt.issuer] } : undefined
  }
}

@Injectable()
export class McpAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user: AuthContext }>()
    const user = request.user
    if (!user?.userId || !user.mcp) {
      throw new UnauthorizedException('MCP resource user token required')
    }
    if (request.headers.origin !== undefined) throw new ForbiddenException('Browser origins may not call MCP')
    return true
  }
}

@Catch(UnauthorizedException)
export class McpAuthChallengeFilter extends AllExceptionsFilter {
  constructor(
    private readonly metadata: McpAuthMetadata,
    tracker: FailedAuthTrackerService,
  ) {
    super(tracker)
  }

  catch(exception: UnauthorizedException, host: ArgumentsHost): Promise<void> {
    const challenge = this.metadata.url ? `Bearer resource_metadata="${this.metadata.url}"` : 'Bearer'
    host.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', challenge)
    return super.catch(exception, host)
  }
}
