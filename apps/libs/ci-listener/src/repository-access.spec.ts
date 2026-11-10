/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync } from 'node:crypto'
import { GitHubAppSource } from './github-app'
import { InstallationRepositoryReader, installationSettingsUrl } from './repository-access'

describe('CI metadata repository pages', () => {
  const original = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const expected = { installationId: 11, accountId: 7, accountLogin: 'owner', accountType: 'User' as const }
  const repository = { id: 21, name: 'web', private: true, owner: { id: 7, login: 'owner' } }
  let reader: InstallationRepositoryReader, source: GitHubAppSource
  let calls: string[], total: number, repositories: unknown[], invalidToken: boolean, failRetirement: boolean
  let beforeIssue: (() => Promise<void>) | undefined
  let selection: string, reported: jest.Mock
  beforeEach(() => {
    calls = []
    total = 1
    repositories = [repository]
    invalidToken = failRetirement = false
    beforeIssue = undefined
    selection = 'selected'
    reported = jest.fn()
    reader = new InstallationRepositoryReader(reported)
    source = new GitHubAppSource({ issuer: 'test', privateKey: () => keys.privateKey })
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input))
      calls.push(`${options?.method ?? 'GET'} ${url.pathname}${url.search}`)
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (url.pathname === '/app/installations/11')
        return json({
          id: 11,
          account: { id: 7, login: 'owner', type: 'User' },
          suspended_at: null,
          permissions: { metadata: 'read' },
          repository_selection: selection,
        })
      if (url.pathname.endsWith('/access_tokens')) {
        expect(JSON.parse(String(options?.body))).toEqual({ permissions: { metadata: 'read' } })
        await beforeIssue?.()
        return json(
          {
            token: 'test-metadata-token',
            permissions: invalidToken ? { actions: 'write' } : { metadata: 'read' },
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          201,
        )
      }
      if (url.pathname === '/installation/repositories') return json({ total_count: total, repositories })
      if (url.pathname === '/installation/token') return new Response(null, { status: failRetirement ? 503 : 204 })
      throw new Error('Unexpected metadata test request')
    }) as typeof fetch
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    failRetirement = false
    await reader.close()
    global.fetch = original
  })
  it('reads only one bounded metadata page, including Private repos, and retires its credential', async () => {
    const value = await reader.page(source, expected)
    expect(value).toMatchObject({
      repositories: [repository],
      total: 1,
      page: 1,
      next_page: null,
      repository_selection: 'selected',
      installation_settings_url: 'https://github.com/settings/installations/11',
    })
    expect(calls.filter((call) => call.includes('/installation/repositories'))).toEqual([
      'GET /installation/repositories?per_page=25&page=1',
    ])
    expect(calls.at(-1)).toBe('DELETE /installation/token')
    expect(JSON.stringify(value)).not.toContain('test-metadata-token')
  })
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid page %s before issuing credentials', async (page) => {
    await expect(reader.page(source, expected, page)).rejects.toThrow('Invalid repository page')
    expect(calls).toEqual([])
  })
  it('keeps pagination metadata and distinguishes an empty authorized inventory', async () => {
    total = 2
    repositories = [repository]
    expect(await reader.page(source, expected, 1, 1)).toMatchObject({ next_page: 2, total: 2 })
    total = 0
    repositories = []
    expect(await reader.page(source, expected)).toMatchObject({ repositories: [], total: 0, next_page: null })
  })
  it.each(['foreign', 'duplicate', 'truncated', 'mode'])(
    'rejects invalid %s inventories and still retires the token',
    async (kind) => {
      if (kind === 'foreign') repositories = [{ ...repository, owner: { id: 8, login: 'other' } }]
      if (kind === 'duplicate') {
        repositories = [repository, repository]
        total = 2
      }
      if (kind === 'truncated') total = 2
      if (kind === 'mode') selection = 'unknown'
      await expect(reader.page(source, expected)).rejects.toThrow()
      if (kind !== 'mode') expect(calls.at(-1)).toBe('DELETE /installation/token')
    },
  )
  it('retains invalid credential metadata for revocation without reading repositories', async () => {
    invalidToken = true
    await expect(reader.page(source, expected)).rejects.toThrow('Invalid metadata credential')
    expect(calls.some((call) => call.startsWith('GET /installation/repositories'))).toBe(false)
    expect(calls.at(-1)).toBe('DELETE /installation/token')
  })
  it('retires a late issued handle even when the browser cancels before the response arrives', async () => {
    const cancel = new AbortController()
    beforeIssue = async () => {
      cancel.abort()
    }
    await expect(reader.page(source, expected, 1, 25, cancel.signal)).rejects.toThrow()
    expect(calls.at(-1)).toBe('DELETE /installation/token')
  })
  it('retains failed retirement for shutdown retry', async () => {
    failRetirement = true
    await reader.page(source, expected)
    expect(reported).toHaveBeenCalledTimes(1)
    failRetirement = false
    await reader.close()
    expect(calls.filter((call) => call === 'DELETE /installation/token')).toHaveLength(2)
  })
  it('defers reminting after uncertain issuance and permits a later request after cooldown', async () => {
    beforeIssue = async () => {
      throw new Error('Unknown issuance result')
    }
    await expect(reader.page(source, expected)).rejects.toThrow()
    beforeIssue = undefined
    await expect(reader.page(source, expected)).rejects.toThrow('busy')
    expect(calls.filter((call) => call.endsWith('/access_tokens'))).toHaveLength(1)
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 60001)
    await expect(reader.page(source, expected)).resolves.toMatchObject({ total: 1 })
  })
  it('forgets failed retirement only after verified expiry, retaining handles with invalid metadata', async () => {
    failRetirement = true
    await reader.page(source, expected)
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 3600001)
    await expect(reader.close()).resolves.toBeUndefined()
    jest.restoreAllMocks()
    reader = new InstallationRepositoryReader(reported)
    invalidToken = true
    await expect(reader.page(source, expected)).rejects.toThrow('Invalid metadata credential')
    jest.spyOn(Date, 'now').mockReturnValue(now + 7200002)
    await expect(reader.close()).rejects.toThrow('retirement remains pending')
  })
  it('reserves the 32-handle bound before asynchronous issuance and drains pending work at shutdown', async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve
      })
    beforeIssue = async () => {
      entered()
      await gate
    }
    const pending = Array.from({ length: 32 }, () => reader.page(source, expected))
    await started
    await expect(reader.page(source, expected)).rejects.toThrow('busy')
    const closing = reader.close()
    await expect(reader.page(source, expected)).rejects.toThrow('busy')
    release()
    await Promise.all(pending)
    await closing
    expect(calls.filter((call) => call === 'DELETE /installation/token')).toHaveLength(32)
  })
  it('constructs Personal and Org installation settings without accepting arbitrary hosts or paths', () => {
    expect(installationSettingsUrl({ ...expected, accountType: 'Organization' })).toBe(
      'https://github.com/organizations/owner/settings/installations/11',
    )
    expect(() => installationSettingsUrl({ ...expected, accountLogin: '../outside' })).toThrow()
    expect(() => installationSettingsUrl({ ...expected, installationId: 0 })).toThrow()
  })
})
