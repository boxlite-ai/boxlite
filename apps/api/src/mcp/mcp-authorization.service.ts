/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { UserService } from '../user/user.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { TypedConfigService } from '../config/typed-config.service'
import { McpGrantStore } from './mcp-grant.store'

export type McpScope = 'boxes:read' | 'boxes:write' | 'boxes:delete'

/** A revocable reference; queued work must never retain the bearer credential. */
export interface McpIdentity {
  userId: string
  organizationId: string
  credential:
    | { kind: 'api_key'; keyHash: string }
    | { kind: 'oauth'; grantId: string; clientId: string; scopes: McpScope[]; expiresAt: number }
}

export type McpCaller = OrganizationAuthContext & McpIdentity & { scopes: McpScope[] }

const RESOURCE_PERMISSIONS: Record<McpScope, OrganizationResourcePermission[]> = {
  'boxes:read': [],
  'boxes:write': [OrganizationResourcePermission.WRITE_BOXES],
  'boxes:delete': [OrganizationResourcePermission.DELETE_BOXES],
}

@Injectable()
export class McpAuthorizationService {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly users: UserService,
    private readonly organizations: OrganizationService,
    private readonly memberships: OrganizationUserService,
    private readonly grants: McpGrantStore,
    private readonly jwt: JwtStrategy,
    private readonly config: TypedConfigService,
  ) {}

  async authenticate(token: string): Promise<McpCaller> {
    if (token.split('.').length !== 3) return this.authenticateKey(token)
    const resource = this.config.get('mcp.resourceUrl')
    if (!resource || !this.config.get('mcp.oauthEnabled')) throw new UnauthorizedException()
    let claims: Awaited<ReturnType<JwtStrategy['verifyToken']>>
    try {
      claims = await this.jwt.verifyToken(token, resource)
    } catch {
      throw new UnauthorizedException('Invalid MCP token')
    }
    const grantId = claims['https://boxlite.ai/mcp/grant_id']
    const organizationId = claims['https://boxlite.ai/mcp/organization_id']
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.azp !== 'string' ||
      typeof claims.exp !== 'number' ||
      typeof grantId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(grantId) ||
      typeof organizationId !== 'string' ||
      typeof claims.scope !== 'string'
    )
      throw new UnauthorizedException('Missing MCP grant claims')
    const identity: McpIdentity = {
      userId: claims.sub,
      organizationId,
      credential: {
        kind: 'oauth',
        grantId,
        clientId: claims.azp,
        expiresAt: claims.exp * 1000,
        scopes: claims.scope.split(' ').filter((s): s is McpScope => s in RESOURCE_PERMISSIONS),
      },
    }
    return this.resolveGrant(identity)
  }

  async authenticateKey(token: string): Promise<McpCaller> {
    // The general API-key strategy also accepts machine credentials and caches
    // revocation. MCP accepts only live, user-owned organization keys.
    return this.resolve(await this.readKey(() => this.keys.getApiKeyByValue(token)))
  }

  async authorize(identity: McpIdentity, scope: McpScope): Promise<McpCaller> {
    if (identity.credential.kind === 'oauth') {
      const caller = await this.resolveGrant(identity)
      if (!caller.scopes.includes(scope)) throw new ForbiddenException('MCP permission denied')
      return caller
    }
    const keyHash = identity.credential.keyHash
    const key = await this.readKey(() => this.keys.getApiKeyByHash(keyHash))
    if (key.userId !== identity.userId || key.organizationId !== identity.organizationId) {
      throw new UnauthorizedException('MCP credential identity changed')
    }
    const caller = await this.resolve(key)
    if (!caller.scopes.includes(scope)) throw new ForbiddenException('MCP permission denied')
    return caller
  }

  async member(userId: string, organizationId: string): Promise<OrganizationAuthContext & { scopes: McpScope[] }> {
    const [user, organization, organizationUser] = await Promise.all([
      this.users.findOne(userId),
      this.organizations.findOne(organizationId),
      this.memberships.findOne(organizationId, userId),
    ])
    if (!user || user.role !== SystemRole.USER) throw new UnauthorizedException('User credential required')
    if (!organization || !organizationUser) throw new ForbiddenException('Organization not accessible')
    const member = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId,
      organization,
      organizationUser,
    }
    return {
      ...member,
      scopes: (Object.keys(RESOURCE_PERMISSIONS) as McpScope[]).filter((scope) =>
        hasOrganizationResourcePermissions(member, RESOURCE_PERMISSIONS[scope]),
      ),
    }
  }

  private async resolveGrant(identity: McpIdentity): Promise<McpCaller> {
    const credential = identity.credential
    if (
      credential.kind !== 'oauth' ||
      credential.expiresAt <= Date.now() ||
      !this.config.get('mcp.oauthEnabled') ||
      !this.config.get('mcp.oauthClientIds').includes(credential.clientId)
    )
      throw new UnauthorizedException('MCP OAuth unavailable or expired')
    const grant = await this.grants.read(credential.grantId)
    if (
      grant.user_id !== identity.userId ||
      grant.organization_id !== identity.organizationId ||
      grant.client_id !== credential.clientId ||
      grant.resource !== this.config.get('mcp.resourceUrl')
    )
      throw new UnauthorizedException('MCP grant identity mismatch')
    const member = await this.member(identity.userId, identity.organizationId)
    return {
      ...member,
      ...identity,
      scopes: member.scopes.filter((scope) => grant.scopes.includes(scope) && credential.scopes.includes(scope)),
    }
  }

  private async readKey(read: () => Promise<ApiKey>): Promise<ApiKey> {
    try {
      return await read()
    } catch (error) {
      if (error instanceof NotFoundException) throw new UnauthorizedException('Invalid MCP credential')
      throw error
    }
  }

  private async resolve(key: ApiKey): Promise<McpCaller> {
    if (!key.userId || !key.organizationId || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      throw new UnauthorizedException('Invalid MCP credential')
    }
    const member = await this.member(key.userId, key.organizationId)
    // A key cannot retain a permission removed from its owner's membership.
    // Owners bypass membership permissions, but never the key's own scopes.
    const scopes = member.scopes.filter((scope) => {
      const required = RESOURCE_PERMISSIONS[scope]
      return (
        hasOrganizationResourcePermissions(member, required) &&
        hasOrganizationResourcePermissions({ ...member, apiKey: key }, required)
      )
    })
    return {
      ...member,
      apiKey: key,
      scopes,
      credential: { kind: 'api_key', keyHash: key.keyHash },
    }
  }
}
