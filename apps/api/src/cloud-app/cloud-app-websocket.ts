import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Request } from 'express'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JwtStrategy } from '../auth/jwt.strategy'
import { JWT_REGEX } from '../auth/constants/jwt-regex.constant'
import { isAuthContext, OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { CloudAppService } from './cloud-app.service'
import { principalStorage } from './engine/platform-principal'
import { handleDbConnect } from './engine/dbproxy'
import { bearer } from './engine/auth'

@Injectable()
export class CloudAppWebsocket {
  constructor(
    private readonly apps: CloudAppService,
    private readonly apiKeys: ApiKeyStrategy,
    private readonly jwt: JwtStrategy,
    private readonly organizations: OrganizationService,
    private readonly members: OrganizationUserService,
  ) {}

  matches(url: string | undefined): boolean {
    return /^\/api\/v1\/[^/]+\/apps\/[^/]+\/envs\/[^/]+\/db\/connect(?:\?|$)/.test(url || '')
  }

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url || '/', 'http://platform.local')
      const organizationId = url.pathname.split('/')[3]
      const token = bearer(req.headers.authorization)
      if (!token) throw new UnauthorizedException()
      const user = JWT_REGEX.test(token)
        ? await this.jwt.validate(req as Request, await this.jwt.verifyToken(token))
        : await this.apiKeys.validate(token)
      if (!user || !isAuthContext(user)) throw new UnauthorizedException()
      if (user.apiKey && user.apiKey.organizationId !== organizationId) throw new ForbiddenException()
      const organization = await this.organizations.findOne(organizationId)
      const organizationUser = await this.members.findOne(organizationId, user.userId)
      const auth = { ...user, organizationId, organization, organizationUser } as OrganizationAuthContext
      const path = url.pathname.slice(`/api/v1/${organizationId}`.length)
      const principal = this.apps.principal(auth, url.searchParams.get('write') === '1' ? 'POST' : 'GET', path)
      req.url = `/v1${path}${url.search}`
      await principalStorage.run(principal, () => handleDbConnect(this.apps.context(organizationId), req, socket, head))
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }
}
