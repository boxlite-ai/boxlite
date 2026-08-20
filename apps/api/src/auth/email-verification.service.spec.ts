/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, UnprocessableEntityException } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../config/typed-config.service'
import { EmailVerificationCooldownException, EmailVerificationService } from './email-verification.service'

jest.mock('axios')

const axiosGet = axios.get as jest.Mock
const axiosPost = axios.post as jest.Mock

const configValues: Record<string, unknown> = {
  skipUserEmailVerification: false,
  'oidc.clientId': 'dashboard-client',
  'oidc.managementApi.enabled': true,
  'oidc.managementApi.baseUrl': 'https://tenant.auth0.com/api/v2/',
  'oidc.managementApi.tokenUrl': 'https://tenant.auth0.com/oauth/token',
  'oidc.managementApi.clientId': 'management-client',
  'oidc.managementApi.clientSecret': 'management-secret',
  'oidc.managementApi.audience': 'https://tenant.auth0.com/api/v2/',
  'oidc.managementApi.customDomain': 'auth.boxlite.test',
}

function buildService(overrides: Record<string, unknown> = {}) {
  const values = { ...configValues, ...overrides }
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key]
      if (value === undefined) throw new Error(`Missing config: ${key}`)
      return value
    }),
  } as unknown as TypedConfigService
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    ttl: jest.fn().mockResolvedValue(60),
    del: jest.fn().mockResolvedValue(1),
  }

  return { service: new EmailVerificationService(configService, redis as never), configService, redis }
}

describe('EmailVerificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axiosPost.mockResolvedValueOnce({ data: { access_token: 'management-token', expires_in: 3600 } })
  })

  it('queues an Auth0 verification job for the token subject', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        user_id: 'auth0|user-1',
        email: 'developer@example.com',
        email_verified: false,
        identities: [{ provider: 'auth0', user_id: 'user-1' }],
      },
    })
    axiosPost.mockResolvedValueOnce({ data: { id: 'verification-job' } })
    const { service, redis } = buildService()

    await service.resend({ subject: 'auth0|user-1', emailVerified: false })

    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^email-verification:resend:/), '1', 'EX', 60, 'NX')
    expect(axiosGet).toHaveBeenCalledWith('https://tenant.auth0.com/api/v2/users/auth0%7Cuser-1', {
      headers: { Authorization: 'Bearer management-token' },
      timeout: 10_000,
    })
    expect(axiosPost).toHaveBeenLastCalledWith(
      'https://tenant.auth0.com/api/v2/jobs/verification-email',
      { user_id: 'auth0|user-1', client_id: 'dashboard-client' },
      {
        headers: {
          Authorization: 'Bearer management-token',
          'auth0-custom-domain': 'auth.boxlite.test',
        },
        timeout: 10_000,
      },
    )
  })

  it('includes the concrete identity for a primary social account', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        user_id: 'google-oauth2|google-user-1',
        email: 'developer@example.com',
        email_verified: false,
        identities: [{ provider: 'google-oauth2', user_id: 'google-user-1' }],
      },
    })
    axiosPost.mockResolvedValueOnce({ data: { id: 'verification-job' } })
    const { service } = buildService()

    await service.resend({ subject: 'google-oauth2|google-user-1', emailVerified: false })

    expect(axiosPost).toHaveBeenLastCalledWith(
      expect.stringContaining('/jobs/verification-email'),
      {
        user_id: 'google-oauth2|google-user-1',
        client_id: 'dashboard-client',
        identity: { provider: 'google-oauth2', user_id: 'google-user-1' },
      },
      expect.any(Object),
    )
  })

  it('returns a server-derived retry window without contacting Auth0 during cooldown', async () => {
    const { service, redis } = buildService()
    redis.set.mockResolvedValueOnce(null)
    redis.ttl.mockResolvedValueOnce(37)

    let error: unknown
    try {
      await service.resend({ subject: 'auth0|user-1', emailVerified: false })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(EmailVerificationCooldownException)
    expect(error).toMatchObject({ retryAfterSeconds: 37 })
    expect(axiosGet).not.toHaveBeenCalled()
  })

  it('reports a now-verified upstream account and releases the cooldown key', async () => {
    axiosGet.mockResolvedValueOnce({
      data: { user_id: 'auth0|user-1', email: 'developer@example.com', email_verified: true, identities: [] },
    })
    const { service, redis } = buildService()

    await expect(service.resend({ subject: 'auth0|user-1', emailVerified: false })).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(redis.del).toHaveBeenCalledTimes(1)
  })

  it('refuses an Auth0 identity that has no usable email address', async () => {
    axiosGet.mockResolvedValueOnce({
      data: { user_id: 'auth0|user-1', email_verified: false, identities: [{ provider: 'auth0', user_id: 'user-1' }] },
    })
    const { service } = buildService()

    await expect(service.resend({ subject: 'auth0|user-1', emailVerified: false })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    )
  })

  it('fails startup when verification is required but the Auth0 adapter is incomplete', () => {
    const { service } = buildService({ 'oidc.managementApi.tokenUrl': undefined })

    expect(() => service.onModuleInit()).toThrow(/OIDC_MANAGEMENT_API_TOKEN_URL/)
  })

  it('allows local providers to omit Auth0 management settings when verification is skipped', () => {
    const { service } = buildService({
      skipUserEmailVerification: true,
      'oidc.managementApi.enabled': false,
      'oidc.managementApi.baseUrl': undefined,
      'oidc.managementApi.tokenUrl': undefined,
    })

    expect(() => service.onModuleInit()).not.toThrow()
  })
})
