/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}))

import axios from 'axios'
import { Auth0ManagementService } from './auth0-management.service'

const get = axios.get as jest.Mock
const post = axios.post as jest.Mock
const patch = axios.patch as jest.Mock

const BASE_URL = 'https://tenant.us.auth0.com/api/v2'
const TOKEN_URL = 'https://tenant.us.auth0.com/oauth/token'

function makeService() {
  const values: Record<string, unknown> = {
    'oidc.managementApi.baseUrl': BASE_URL,
    'oidc.managementApi.tokenUrl': TOKEN_URL,
    'oidc.managementApi.clientId': 'management-client',
    'oidc.managementApi.clientSecret': 'redacted',
    'oidc.managementApi.audience': `${BASE_URL}/`,
  }
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`auth0-management.service.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  return new Auth0ManagementService(configService as any)
}

/** The Management API calls after the token exchange, which is always the first post. */
function managementPosts() {
  expect(post.mock.calls[0][0]).toBe(TOKEN_URL)
  return post.mock.calls.slice(1)
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  post.mockImplementation(async (url: string) =>
    url === TOKEN_URL ? { data: { access_token: 'management-token' } } : { data: [] },
  )
  patch.mockResolvedValue({ data: {} })
})

describe('Auth0ManagementService.linkIdentity', () => {
  it.each([
    ['a Google user', 'google-oauth2|103', { provider: 'google-oauth2', user_id: '103' }],
    // Only the first separator divides provider from id; an enterprise id may carry more.
    ['an id that itself holds a separator', 'samlp|acme|ada', { provider: 'samlp', user_id: 'acme|ada' }],
  ])('links %s into the primary account by provider and id', async (_case, secondary, body) => {
    await makeService().linkIdentity('auth0|primary', secondary)

    expect(managementPosts()).toEqual([
      [
        `${BASE_URL}/users/auth0%7Cprimary/identities`,
        body,
        { headers: { Authorization: 'Bearer management-token' }, maxRedirects: 0 },
      ],
    ])
  })

  it.each(['google-oauth2', '|103', 'google-oauth2|'])('refuses %s, which is no Auth0 user id', async (secondary) => {
    await expect(makeService().linkIdentity('auth0|primary', secondary)).rejects.toThrow('not an Auth0 user id')
    expect(post).not.toHaveBeenCalled()
  })
})

describe('Auth0ManagementService.markEmailVerified', () => {
  it('patches only the verified flag on that user', async () => {
    await makeService().markEmailVerified('auth0|new-account')

    expect(patch).toHaveBeenCalledWith(
      `${BASE_URL}/users/auth0%7Cnew-account`,
      { email_verified: true },
      { headers: { Authorization: 'Bearer management-token' }, maxRedirects: 0 },
    )
  })
})

describe('Auth0ManagementService.usersByEmail', () => {
  it('asks for every user holding the address, across connections', async () => {
    const users = [
      { user_id: 'auth0|primary', identities: [{ provider: 'auth0', user_id: 'primary', connection: 'db' }] },
    ]
    get.mockResolvedValue({ data: users })

    await expect(makeService().usersByEmail('ada@example.com')).resolves.toEqual(users)
    expect(get).toHaveBeenCalledWith(`${BASE_URL}/users-by-email`, {
      params: { email: 'ada@example.com' },
      headers: { Authorization: 'Bearer management-token' },
      maxRedirects: 0,
    })
  })
})
