/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiKey } from '../api-key/api-key.entity'
import { AuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationService } from '../organization/services/organization.service'
import { BoxliteMeController } from './boxlite-me.controller'

describe('BoxliteMeController', () => {
  // resolvePathPrefix only touches OrganizationService on the user-session path;
  // API-key contexts short-circuit on apiKey.organizationId.
  function makeController(orgFindByUser: jest.Mock = jest.fn()): BoxliteMeController {
    const organizationService = { findByUserWithDefaultFlag: orgFindByUser } as unknown as OrganizationService
    return new BoxliteMeController(organizationService)
  }

  function apiKeyContext(expiresAt?: Date): AuthContext {
    const apiKey = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      name: 'key-531',
      expiresAt,
    } as ApiKey
    return {
      userId: 'user-1',
      email: 'svc@example.com',
      role: 'user' as AuthContext['role'],
      apiKey,
      organizationId: apiKey.organizationId,
    }
  }

  describe('GET /v1/me — expires_at is sourced from ApiKey.expiresAt', () => {
    it('returns the API key expiry as an ISO string (same field the dashboard renders)', async () => {
      const expiresAt = new Date('2026-06-07T12:00:00.000Z')
      const result = await makeController().getMe(apiKeyContext(expiresAt))

      expect(result.principal_type).toBe('service_account')
      expect(result.expires_at).toBe(expiresAt.toISOString())
    })

    it('returns null for a non-expiring API key (expiresAt unset)', async () => {
      const result = await makeController().getMe(apiKeyContext(undefined))

      expect(result.expires_at).toBeNull()
    })

    it('returns null for an interactive user session (no API key)', async () => {
      const findByUser = jest.fn().mockResolvedValue([])
      const ctx: AuthContext = {
        userId: 'user-2',
        email: 'human@example.com',
        role: 'user' as AuthContext['role'],
      }

      const result = await makeController(findByUser).getMe(ctx)

      expect(result.principal_type).toBe('user')
      expect(result.expires_at).toBeNull()
    })
  })
})
