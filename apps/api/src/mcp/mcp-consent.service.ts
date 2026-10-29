/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { jwtVerify, SignJWT } from 'jose'
import * as z from 'zod'
import { JwtStrategy } from '../auth/jwt.strategy'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationService } from '../organization/services/organization.service'
import { McpAuthorizationService, McpScope } from './mcp-authorization.service'
import { McpGrantStore } from './mcp-grant.store'

export const MCP_SCOPES = ['boxes:read', 'boxes:write', 'boxes:delete'] as const
const challengeSchema = z.object({
  sub: z.string().min(1),
  client_id: z.string().min(1).max(256),
  client_name: z.string().min(1).max(256),
  resource: z.url(),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
  nonce: z.uuid(),
  exp: z.number(),
})

@Injectable()
export class McpConsentService {
  constructor(
    private readonly config: TypedConfigService,
    private readonly jwt: JwtStrategy,
    private readonly authorization: McpAuthorizationService,
    private readonly organizations: OrganizationService,
    private readonly grants: McpGrantStore,
  ) {}

  async preview(userId: string, token: string) {
    const challenge = await this.challenge(userId, token)
    const organizations = await this.organizations.findByUserWithDefaultFlag(userId)
    const choices = await Promise.all(
      organizations.map(async ({ organization }) => {
        const member = await this.authorization.member(userId, organization.id)
        return {
          id: organization.id,
          name: organization.name,
          scopes: challenge.scopes.filter((scope) => member.scopes.includes(scope)),
        }
      }),
    )
    return {
      client_name: challenge.client_name,
      client_id: challenge.client_id,
      scopes: challenge.scopes,
      organizations: choices,
      expires_at: new Date(challenge.exp * 1000).toISOString(),
    }
  }

  async approve(userId: string, token: string, state: string, organizationId: string, scopes: McpScope[]) {
    const challenge = await this.challenge(userId, token)
    const member = await this.authorization.member(userId, organizationId)
    this.organizations.assertOrganizationIsNotSuspended(member.organization)
    if (
      !scopes.length ||
      !scopes.includes('boxes:read') ||
      scopes.some((scope) => !challenge.scopes.includes(scope) || !member.scopes.includes(scope))
    ) {
      throw new ForbiddenException('Requested MCP scopes are not available')
    }
    const grant = await this.grants.create({
      organization_id: organizationId,
      user_id: userId,
      client_id: challenge.client_id,
      client_name: challenge.client_name,
      resource: challenge.resource,
      scopes: [...new Set(scopes)],
      challenge_nonce: challenge.nonce,
    })
    const continuation = await new SignJWT({
      state,
      grant_id: grant.id,
      organization_id: organizationId,
      client_id: challenge.client_id,
      resource: challenge.resource,
      scopes: grant.scopes,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(challenge.resource)
      .setAudience('boxlite-mcp-continue')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(this.secret())
    return { continue_url: new URL('/continue', this.jwt.issuer).href, state, session_token: continuation }
  }

  private secret(): Uint8Array {
    const secret = this.config.get('mcp.consentSecret')
    if (!secret || Buffer.byteLength(secret) < 32) throw new UnauthorizedException('MCP consent is not configured')
    return new TextEncoder().encode(secret)
  }

  private async challenge(userId: string, token: string) {
    if (!this.config.get('mcp.oauthEnabled')) throw new UnauthorizedException('MCP OAuth is disabled')
    let data: unknown
    try {
      const result = await jwtVerify(token, this.secret(), {
        algorithms: ['HS256'],
        issuer: new URL(this.jwt.issuer).hostname,
        audience: 'boxlite-mcp-consent',
        requiredClaims: ['exp', 'sub'],
      })
      data = result.payload
    } catch {
      throw new UnauthorizedException('Invalid or expired consent challenge')
    }
    const parsed = challengeSchema.safeParse(data)
    if (
      !parsed.success ||
      parsed.data.sub !== userId ||
      parsed.data.resource !== this.config.get('mcp.resourceUrl') ||
      !this.config.get('mcp.oauthClientIds').includes(parsed.data.client_id)
    )
      throw new UnauthorizedException('Consent identity mismatch')
    return parsed.data
  }
}
