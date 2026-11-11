/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync } from 'node:crypto'
import { GitHubAppSource, GitHubCredential } from './github-app'
import { GitHubRequestError } from './github'

describe('CI shared App credentials', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    original = global.fetch
  let clock: number,
    app: GitHubAppSource,
    installation: any,
    issued: any,
    calls: { path: string; method: string; body: any }[],
    closeFailures: number
  beforeEach(() => {
    clock = Date.now()
    calls = []
    closeFailures = 0
    installation = {
      id: 7,
      account: { id: 8, login: 'alice', type: 'User' },
      permissions: {
        metadata: 'read',
        actions: 'read',
        administration: 'write',
        organization_self_hosted_runners: 'write',
      },
      suspended_at: null,
    }
    issued = {
      token: 'test-installation-token',
      expires_at: new Date(clock + 3_600_000).toISOString(),
      permissions: { actions: 'read', metadata: 'read' },
      repositories: [{ id: 11 }],
    }
    app = new GitHubAppSource({ issuer: 'app-client', privateKey: () => keys.privateKey, now: () => clock })
    global.fetch = jest.fn(async (address, options) => {
      const path = new URL(String(address)).pathname,
        method = options?.method ?? 'GET'
      calls.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : undefined })
      if (path === '/app/installations/7') return new Response(JSON.stringify(installation))
      if (path === '/app/installations') return new Response(JSON.stringify([installation]))
      if (path.endsWith('/access_tokens')) return new Response(JSON.stringify(issued), { status: 201 })
      if (path === '/installation/token')
        return closeFailures-- > 0 ? new Response('{}', { status: 503 }) : new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 22 }))
    }) as typeof fetch
  })
  afterEach(() => {
    global.fetch = original
  })
  const tokenPosts = () => calls.filter((call) => call.path.endsWith('/access_tokens'))
  it('requests only the target repository and purpose, then retires its credential', async () => {
    const expected = await app.installation(7),
      credential = await app.issue(expected, { kind: 'jobs', repository: 11 })
    expect(tokenPosts()[0].body).toEqual({ permissions: { actions: 'read' }, repository_ids: [11] })
    expect(credential.usable).toBe(true)
    expect(await credential.request('/repos/alice/example/actions/jobs/22')).toEqual({ id: 22 })
    expect(() => JSON.stringify(credential)).toThrow('memory-only')
    await credential.close()
    await credential.close()
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
    await expect(credential.request('/user')).rejects.toThrow('closed')
  })
  it('downscopes a stronger installation grant to a read credential', async () => {
    installation.permissions.actions = 'write'
    const expected = await app.installation(7),
      credential = await app.issue(expected, { kind: 'jobs', repository: 11 })
    expect(credential.usable).toBe(true)
    expect(tokenPosts()[0].body.permissions).toEqual({ actions: 'read' })
    await credential.close()
  })
  it('captures original token purpose and repository before asynchronous authority checks', async () => {
    const expected = await app.installation(7)
    const purpose: { kind: 'jobs' | 'repository-runners'; repository: number } = { kind: 'jobs', repository: 11 }
    const upstream = global.fetch
    global.fetch = async (...args) => {
      const response = await upstream(...args)
      if (new URL(String(args[0])).pathname === '/app/installations/7') {
        purpose.kind = 'repository-runners'
        purpose.repository = 12
      }
      return response
    }
    const credential = await app.issue(expected, purpose)
    try {
      expect(tokenPosts()[0].body).toEqual({ permissions: { actions: 'read' }, repository_ids: [11] })
      expect(credential.usable).toBe(true)
    } finally {
      await credential.close()
    }
  })
  it('captures original installation identity before asynchronous authority checks', async () => {
    const expected = await app.installation(7),
      upstream = global.fetch
    installation.account.id = 9
    global.fetch = async (...args) => {
      const response = await upstream(...args)
      if (new URL(String(args[0])).pathname === '/app/installations/7') expected.account.id = 9
      return response
    }
    const result = await app.issue(expected, { kind: 'jobs', repository: 11 }).then(
      async (credential) => {
        await credential.close()
        return 'issued'
      },
      () => 'rejected',
    )
    expect(result).toBe('rejected')
    expect(tokenPosts()).toHaveLength(0)
  })
  it('rejects unknown purpose before GitHub credential issuance', async () => {
    installation.account.type = 'Organization'
    const expected = await app.installation(7)
    calls = []
    const result = await app.issue(expected, { kind: 'unexpected' } as never).then(
      async (credential) => {
        await credential.close()
        return 'issued'
      },
      (error) => error.message,
    )
    expect(result).toBe('Invalid GitHub token purpose')
    expect(calls).toEqual([])
  })
  it.each(['owner', 'name', 'type', 'suspended', 'permissions'])(
    'rejects %s changes before token issuance',
    async (change) => {
      const expected = await app.installation(7)
      if (change === 'owner') installation.account.id = 9
      if (change === 'name') installation.account.login = 'other'
      if (change === 'type') installation.account.type = 'Organization'
      if (change === 'suspended') installation.suspended_at = new Date(clock).toISOString()
      if (change === 'permissions') installation.permissions.actions = 'none'
      await expect(app.issue(expected, { kind: 'jobs', repository: 11 })).rejects.toThrow()
      expect(tokenPosts()).toHaveLength(0)
    },
  )
  it.each(['expiry', 'missing-expiry', 'permission', 'repository', 'missing-permission'])(
    'retains invalid %s credentials for revocation without using them',
    async (change) => {
      if (change === 'expiry') issued.expires_at = new Date(clock - 1).toISOString()
      if (change === 'missing-expiry') delete issued.expires_at
      if (change === 'permission') issued.permissions.contents = 'write'
      if (change === 'repository') issued.repositories = [{ id: 12 }]
      if (change === 'missing-permission') delete issued.permissions.actions
      const credential = await app.issue(await app.installation(7), { kind: 'jobs', repository: 11 })
      expect(credential.usable).toBe(false)
      await expect(credential.request('/user')).rejects.toThrow('invalid')
      await credential.close()
      expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(1)
    },
  )
  it('stops using a credential during unconfirmed retirement and retries revocation', async () => {
    const credential = await app.issue(await app.installation(7), { kind: 'jobs', repository: 11 })
    closeFailures = 1
    await expect(credential.close()).rejects.toBeInstanceOf(GitHubRequestError)
    expect(credential.usable).toBe(false)
    await expect(credential.request('/user')).rejects.toThrow('closed')
    await credential.close()
    expect(calls.filter((call) => call.path === '/installation/token')).toHaveLength(2)
  })
  it('expires the short request window while still allowing explicit revocation', async () => {
    const credential = await app.issue(await app.installation(7), { kind: 'jobs', repository: 11 })
    clock += 61_000
    await expect(credential.request('/user')).rejects.toThrow('expired')
    await credential.close()
    const renewed = await app.issue(await app.installation(7), { kind: 'jobs', repository: 11 })
    expect(renewed.usable).toBe(true)
    await renewed.close()
  })
  it('never revokes a user-owned personal token', async () => {
    const credential = GitHubCredential.personal('test-personal-token', () => clock)
    expect(await credential.request('/repos/alice/example')).toEqual({ id: 22 })
    await credential.close()
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  })
  it('reports missing token responses as an unknown issuance outcome', async () => {
    delete issued.token
    await expect(app.issue(await app.installation(7), { kind: 'jobs', repository: 11 })).rejects.toMatchObject({
      uncertain: true,
    })
  })
  it('lists App installations without requiring a single selected repository', async () => {
    expect((await app.installations()).map((item) => item.id)).toEqual([7])
    expect(tokenPosts()).toHaveLength(0)
  })
})
