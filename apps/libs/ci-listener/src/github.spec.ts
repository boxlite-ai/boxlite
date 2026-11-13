/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { createGitHubAppJwt, githubRequest, GitHubRequestError } from './github'

describe('CI shared GitHub transport', () => {
  const original = global.fetch
  afterEach(() => {
    global.fetch = original
  })
  it.each([
    { url: 'https://evil.test/users/team' },
    { url: 'https://github.com/login/device/code', method: 'POST' as const },
    { url: 'https://api.github.com/users/team', method: 'POST' as const },
    { url: 'https://api.github.com/users/team', token: 'another-token' },
  ])('does not forward OAuth App credentials to an invalid request %p', async (request) => {
    global.fetch = jest.fn()
    await expect(
      githubRequest({ ...request, oauthApp: { clientId: 'identity-client', clientSecret: 'private-secret' } }),
    ).rejects.toMatchObject({ uncertain: false })
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('signs a fresh five-minute App JWT with the supplied identity', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const first = createGitHubAppJwt('app-client', keys.privateKey, 1_800_000_000_000).split('.')
    expect(
      verify('RSA-SHA256', Buffer.from(first[0] + '.' + first[1]), keys.publicKey, Buffer.from(first[2], 'base64url')),
    ).toBe(true)
    expect(JSON.parse(Buffer.from(first[1], 'base64url').toString())).toEqual({
      iss: 'app-client',
      iat: 1_799_999_940,
      exp: 1_800_000_300,
    })
    expect(createGitHubAppJwt('app-client', keys.privateKey, 1_800_000_001_000)).not.toBe(first.join('.'))
  })
  it.each([
    'https://evil.test/user',
    'http://api.github.com/user',
    'https://secret@api.github.com/user',
    'https://github.com/login/device/code',
  ])('refuses credential forwarding to %s', async (url) => {
    const called = jest.fn()
    global.fetch = called
    await expect(githubRequest({ url, token: 'private-token' })).rejects.toMatchObject({ uncertain: false })
    expect(called).not.toHaveBeenCalled()
  })
  it('sends bearer auth only to the fixed API origin and parses bounded JSON', async () => {
    global.fetch = jest.fn(async (_url, options) => {
      expect(options?.redirect).toBe('error')
      expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer private-token')
      return new Response(JSON.stringify({ id: 7 }))
    }) as typeof fetch
    expect(await githubRequest({ url: 'https://api.github.com/user', token: 'private-token' })).toEqual({ id: 7 })
  })
  it.each([401, 403, 429, 500])('masks response content and classifies HTTP %i POST outcomes', async (status) => {
    global.fetch = jest.fn(async () => new Response('private-token', { status })) as typeof fetch
    try {
      await githubRequest({
        url: 'https://api.github.com/app/installations/7/access_tokens',
        token: 'private-token',
        json: {},
      })
      throw new Error('request succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRequestError)
      expect(error).toMatchObject({ status, uncertain: status >= 500 })
      expect(String(error)).not.toContain('private-token')
    }
  })
  it('marks a lost POST response as unknown and permits empty DELETE responses', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('private-token')
    }) as typeof fetch
    await expect(
      githubRequest({ url: 'https://api.github.com/app/installations/7/access_tokens', json: {} }),
    ).rejects.toMatchObject({ uncertain: true })
    global.fetch = jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    expect(
      await githubRequest({
        url: 'https://api.github.com/installation/token',
        method: 'DELETE',
        response: 'empty',
        token: 'private-token',
      }),
    ).toBeUndefined()
  })
  it.each([429, 403])('exposes a GitHub retry deadline without exposing response data: %i', async (status) => {
    const earliest = Date.now() + 119000
    const headers: Record<string, string> =
      status === 429
        ? { 'retry-after': '120' }
        : {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.ceil((Date.now() + 120000) / 1000)),
          }
    global.fetch = jest.fn(async () => new Response('private-token', { status, headers })) as typeof fetch
    const error = await githubRequest({ url: 'https://api.github.com/app/installations' }).catch((value) => value)
    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError & { retryAt: number }).retryAt).toBeGreaterThanOrEqual(earliest)
    expect(String(error)).not.toContain('private-token')
  })
  it('rejects oversized or malformed JSON without exposing upstream data', async () => {
    for (const body of ['private-token', '"' + 'x'.repeat(1_048_576) + '"']) {
      global.fetch = jest.fn(async () => new Response(body)) as typeof fetch
      await expect(githubRequest({ url: 'https://api.github.com/user' })).rejects.toMatchObject({
        message: 'GitHub request failed',
        uncertain: false,
      })
    }
  })
})
