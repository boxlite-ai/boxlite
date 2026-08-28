/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
  },
}))

import axios from 'axios'
import { UserController } from './user.controller'

const get = axios.get as jest.Mock
const post = axios.post as jest.Mock
const remove = axios.delete as jest.Mock

const OIDC_ISSUER = 'https://identity.example.com/realms/boxlite'
const MANAGEMENT_BASE_URL = 'https://management.example.com/admin'
const TOKEN_URL = 'https://tokens.example.net/oauth/token?realm=boxlite'

function makeController() {
  const userService = {
    findOne: jest.fn(),
  }
  const values: Record<string, unknown> = {
    'oidc.issuer': OIDC_ISSUER,
    'oidc.managementApi.enabled': true,
    'oidc.managementApi.baseUrl': MANAGEMENT_BASE_URL,
    'oidc.managementApi.tokenUrl': TOKEN_URL,
    'oidc.managementApi.clientId': 'management-client',
    'oidc.managementApi.clientSecret': 'redacted',
    'oidc.managementApi.audience': `${MANAGEMENT_BASE_URL}/`,
  }
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`user.controller.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }

  return {
    controller: new UserController(userService as any, configService as any),
    configService,
    userService,
  }
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  remove.mockReset()
  post.mockImplementation(async (url: string) =>
    url === TOKEN_URL ? { data: { access_token: 'management-token' } } : { data: { ticket_url: 'ticket' } },
  )
  get.mockResolvedValue({ data: [] })
  remove.mockResolvedValue({})
})

describe('UserController OIDC Management API requests', () => {
  it('requests management tokens with a form-encoded body without following redirects', async () => {
    const { controller } = makeController()

    await controller.getAvailableAccountProviders()

    const tokenCall = post.mock.calls.find(([url]) => url === TOKEN_URL)
    expect(tokenCall).toBeDefined()

    const [, body, options] = tokenCall
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(body.toString()).toBe(
      'grant_type=client_credentials&client_id=management-client&client_secret=redacted&audience=https%3A%2F%2Fmanagement.example.com%2Fadmin%2F',
    )
    expect(options).toEqual({
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      maxRedirects: 0,
    })
  })

  it('builds every request from the configured management and token endpoints', async () => {
    const { controller, configService, userService } = makeController()

    await controller.getAvailableAccountProviders()

    userService.findOne.mockResolvedValueOnce({ emailVerified: true }).mockResolvedValueOnce(null)
    await controller.linkAccount({ userId: 'auth0|primary' } as any, { provider: 'github', userId: 'secondary' } as any)

    await controller.unlinkAccount({ userId: 'auth0|primary' } as any, 'github', 'secondary')
    await controller.enrollInSmsMfa({ userId: 'auth0|primary' } as any)

    expect(post.mock.calls.filter(([url]) => url === TOKEN_URL)).toHaveLength(4)
    expect(get).toHaveBeenCalledWith(`${MANAGEMENT_BASE_URL}/connections`, expect.any(Object))
    expect(get).toHaveBeenCalledWith(`${MANAGEMENT_BASE_URL}/users/github%7Csecondary`, expect.any(Object))
    expect(post).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/users/auth0%7Cprimary/identities`,
      expect.any(Object),
      expect.any(Object),
    )
    expect(remove).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/users/auth0%7Cprimary/identities/github/secondary`,
      expect.any(Object),
    )
    expect(post).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/guardian/enrollments/ticket`,
      expect.any(Object),
      expect.any(Object),
    )
    expect(configService.getOrThrow).not.toHaveBeenCalledWith('oidc.issuer')
  })

  it('encodes each dynamic management resource path segment', async () => {
    const { controller, userService } = makeController()
    const primaryUserId = 'auth0|primary/account?tenant=boxlite'

    userService.findOne.mockResolvedValueOnce({ emailVerified: true }).mockResolvedValueOnce(null)
    await controller.linkAccount(
      { userId: primaryUserId } as any,
      { provider: 'github', userId: 'secondary/account?source=github' } as any,
    )
    await controller.unlinkAccount(
      { userId: primaryUserId } as any,
      'github:enterprise',
      'secondary/account?source=github',
    )

    expect(get).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/users/github%7Csecondary%2Faccount%3Fsource%3Dgithub`,
      expect.any(Object),
    )
    expect(post).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/users/auth0%7Cprimary%2Faccount%3Ftenant%3Dboxlite/identities`,
      expect.any(Object),
      expect.any(Object),
    )
    expect(remove).toHaveBeenCalledWith(
      `${MANAGEMENT_BASE_URL}/users/auth0%7Cprimary%2Faccount%3Ftenant%3Dboxlite/identities/github%3Aenterprise/secondary%2Faccount%3Fsource%3Dgithub`,
      expect.any(Object),
    )
  })
})
