/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { errors } from 'jose'
import { OrganizationResourcePermission as P } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'
import { McpAuthGuard } from './mcp-auth.guard'
import { mcpOAuthScopes } from './mcp-oauth-policy'

const MCP_AUDIENCE = 'https://api.example.test/mcp'
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln'

function contextFor(authorization?: string) {
  const request: Record<string, unknown> = { headers: authorization ? { authorization } : {} }
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
  return { request, context }
}

interface OAuthUser {
  role?: SystemRole
  scope?: string
  membership?: { organizationId: string; permissions: Set<P> } | null
}

function guardWith(apiKeyCaller: unknown, oauth: OAuthUser = {}, resourceAudience: string | null = MCP_AUDIENCE) {
  // Like `JwtStrategy.verifyToken`: no audience means the dashboard audience, which this token also carries.
  const verifyToken = jest.fn(async (_token: string, audience?: string) => {
    if (audience !== undefined && audience !== MCP_AUDIENCE) {
      throw new errors.JWTClaimValidationFailed('aud', {} as never)
    }
    return { sub: 'user-1', scope: oauth.scope ?? 'openid write:boxes' }
  })
  const validate = jest.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
    role: oauth.role ?? SystemRole.USER,
  }))
  const membership =
    oauth.membership === undefined
      ? { organizationId: 'org-default', permissions: new Set(Object.values(P)) }
      : oauth.membership
  const organizationUsers = { findDefault: jest.fn(async () => membership) }
  const apiKeyStrategy = { validate: jest.fn(async () => apiKeyCaller) }
  const guard = new McpAuthGuard(
    { verifyToken, validate } as never,
    apiKeyStrategy as never,
    { audience: resourceAudience ?? undefined } as never,
    organizationUsers as never,
  )
  return { guard, verifyToken }
}

describe('McpAuthGuard', () => {
  it('refuses every OAuth token when no MCP resource URL is configured', async () => {
    const { guard } = guardWith(null, {}, null)
    const { request, context } = contextFor(`Bearer ${JWT}`)

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(request.user).toBeUndefined()
  })

  it('verifies an OAuth token against the MCP resource audience', async () => {
    const { guard, verifyToken } = guardWith(null)
    const { request, context } = contextFor(`Bearer ${JWT}`)

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(verifyToken).toHaveBeenCalledWith(JWT, MCP_AUDIENCE)
    expect(request.user).toMatchObject({ userId: 'user-1', organizationId: 'org-default' })
  })

  it('maps an OAuth token to a user-role caller of its default organization, holding only MCP scopes its role has', async () => {
    const { guard } = guardWith(null, {
      role: SystemRole.ADMIN,
      scope: 'openid write:boxes delete:boxes write:members',
      membership: { organizationId: 'org-default', permissions: new Set([P.WRITE_BOXES, P.WRITE_MEMBERS]) },
    })
    const { request, context } = contextFor(`Bearer ${JWT}`)

    await guard.canActivate(context)

    expect(request.user).toEqual({
      userId: 'user-1',
      email: 'u@example.test',
      role: SystemRole.USER,
      organizationId: 'org-default',
      apiKey: { organizationId: 'org-default', userId: 'user-1', name: 'mcp-oauth', permissions: [P.WRITE_BOXES] },
    })
    expect(mcpOAuthScopes(request as never)).toEqual([P.WRITE_BOXES, P.DELETE_BOXES])
  })

  it('refuses an OAuth caller without a default organization', async () => {
    const { guard } = guardWith(null, { membership: null })

    await expect(guard.canActivate(contextFor(`Bearer ${JWT}`).context)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('admits a user API key as REST maps it', async () => {
    const caller = { userId: 'user-1', role: 'user', email: 'u@example.test', organizationId: 'org-1' }
    const { guard } = guardWith(caller)
    const { request, context } = contextFor('Bearer bxl_user_key')

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.user).toBe(caller)
    expect(mcpOAuthScopes(request as never)).toBeUndefined()
  })

  it.each([
    ['a machine API key', { role: 'proxy' }],
    ['an unknown API key', null],
  ])('refuses %s', async (_label, caller) => {
    const { guard } = guardWith(caller)

    await expect(guard.canActivate(contextFor('Bearer bxl_other').context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('refuses a request without a bearer token', async () => {
    const { guard } = guardWith(null)

    await expect(guard.canActivate(contextFor().context)).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
