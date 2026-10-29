/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpAuthorizationService } from './mcp-authorization.service'
import { CustomHeaders } from '../common/constants/header.constants'

describe('McpAuthGuard', () => {
  const authenticateKey = jest.fn()
  const guard = new McpAuthGuard({ authenticate: authenticateKey } as unknown as McpAuthorizationService)
  function request(headers: Record<string, string>) {
    const req = { headers, get: (name: string) => headers[name.toLowerCase()], user: undefined }
    const context = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext
    return { req, context }
  }
  beforeEach(() => authenticateKey.mockReset())
  it('rejects missing credentials and organization overrides before authentication', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer key', [CustomHeaders.ORGANIZATION_ID.name.toLowerCase()]: 'other' },
    ]) {
      await expect(guard.canActivate(request(headers).context)).rejects.toBeInstanceOf(UnauthorizedException)
    }
    expect(authenticateKey).not.toHaveBeenCalled()
  })
  it('attaches only the caller returned by live credential authorization', async () => {
    const caller = { organizationId: 'org', userId: 'user' }
    authenticateKey.mockResolvedValue(caller)
    const { req, context } = request({ authorization: 'Bearer key' })
    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(req.user).toBe(caller)
    expect(authenticateKey).toHaveBeenCalledWith('key')
  })
})
