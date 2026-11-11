/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { githubRequest } from './github'
import { CiGitHubAppError } from './ci-gh-app'

export type GitHubAccount = { accountId: number; accountLogin: string; accountType: 'User' | 'Organization' }
type Options = {
  clientId: string
  clientSecret(): string
  dashboardUrl?: string
  error?: (status: 403 | 502 | 503, message: string) => Error
}

/** Identity-only OAuth; CI installation credentials never enter this client. */
export class CiGitHubOAuth {
  readonly clientId: string
  private readonly options: Options
  constructor(options: Options) {
    this.clientId = options.clientId
    this.options = Object.freeze({ ...options })
  }
  private failure(status: 403 | 502 | 503, message: string) {
    return this.options.error?.(status, message) ?? new CiGitHubAppError(status, message)
  }
  toJSON(): never {
    throw new Error('GitHub OAuth credentials cannot be serialized')
  }
  async lookupAccount(login: string): Promise<GitHubAccount> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) throw this.failure(403, 'Invalid GitHub account')
    const secret = this.clientSecret()
    let value: any
    try {
      value = await githubRequest({
        url: 'https://api.github.com/users/' + encodeURIComponent(login),
        oauthApp: { clientId: this.clientId, clientSecret: secret },
      })
    } catch {
      throw this.failure(502, 'GitHub account lookup unavailable')
    }
    if (
      !['User', 'Organization'].includes(value?.type) ||
      typeof value?.login !== 'string' ||
      value.login.toLowerCase() !== login.toLowerCase()
    )
      throw this.failure(502, 'Invalid GitHub account identity')
    return this.account(value, value.type)
  }
  private clientSecret(): string {
    const secret = this.options.clientSecret()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(this.clientId) || !/^\S{16,4096}$/.test(secret) || secret === this.clientId)
      throw this.failure(503, 'GitHub identity OAuth is not configured')
    return secret
  }
  webSettings() {
    this.clientSecret()
    try {
      const base = new URL(this.options.dashboardUrl || '')
      if (
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/' ||
        (base.protocol !== 'https:' &&
          !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
      )
        throw new Error('Invalid callback origin')
      return {
        clientId: this.clientId,
        redirectUri: new URL('/settings/ci/callback', base).href,
        authorizationSettingsUrl: 'https://github.com/settings/connections/applications/' + this.clientId,
      }
    } catch {
      throw this.failure(503, 'GitHub identity callback is not configured')
    }
  }
  authorizeWeb(state: string, challenge: string, selectAccount = false) {
    const settings = this.webSettings()
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read:user read:org',
      ...(selectAccount ? { prompt: 'select_account' } : {}),
    }).toString()
    return url.href
  }
  async exchangeWeb(code: string, verifier: string): Promise<string> {
    if (!/^[\x21-\x7e]{1,2048}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(verifier))
      throw this.failure(403, 'Invalid GitHub browser authorization')
    const settings = this.webSettings()
    const result = await this.request('https://github.com/login/oauth/access_token', '', {
      client_id: settings.clientId,
      client_secret: this.options.clientSecret(),
      code,
      code_verifier: verifier,
      redirect_uri: settings.redirectUri,
    })
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw this.failure(502, 'Invalid GitHub OAuth response')
    const scopes = typeof result.scope === 'string' ? result.scope.split(/[ ,]+/).filter(Boolean) : []
    if (
      result.error ||
      typeof result.access_token !== 'string' ||
      !/^\S{1,16384}$/.test(result.access_token) ||
      typeof result.token_type !== 'string' ||
      result.token_type.toLowerCase() !== 'bearer' ||
      scopes.length !== 2 ||
      !['read:user', 'read:org'].every((scope) => scopes.includes(scope))
    )
      throw this.failure(403, 'GitHub identity requires only read:user and read:org; restart authorization')
    return result.access_token
  }
  async ownedAccounts(token: string, signal = AbortSignal.timeout(45_000)) {
    const user = this.account(await this.api('/user', token, signal), 'User')
    const accounts: GitHubAccount[] = [user],
      seen = new Set([user.accountId])
    for (let page = 1; page <= 11; page++) {
      const batch = await this.api(`/user/memberships/orgs?state=active&per_page=100&page=${page}`, token, signal)
      if (!Array.isArray(batch) || batch.length > 100) throw this.failure(502, 'Invalid GitHub membership inventory')
      for (const membership of batch) {
        const account = this.account(membership?.organization, 'Organization')
        if (
          seen.has(account.accountId) ||
          seen.size > 1000 ||
          !['active', 'pending'].includes(membership.state) ||
          !['admin', 'member'].includes(membership.role)
        )
          throw this.failure(502, 'Duplicate or invalid GitHub membership inventory')
        seen.add(account.accountId)
        if (membership.state === 'active' && membership.role === 'admin') accounts.push(account)
      }
      if (batch.length < 100) return { user, accounts }
    }
    throw this.failure(502, 'GitHub membership inventory exceeds pagination limit')
  }
  private account(value: any, type: GitHubAccount['accountType']): GitHubAccount {
    if (
      !Number.isSafeInteger(value?.id) ||
      value.id <= 0 ||
      (value.type !== undefined && value.type !== type) ||
      (type === 'User' && value.type !== 'User') ||
      typeof value.login !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.login)
    )
      throw this.failure(502, 'Invalid GitHub account identity')
    return { accountId: value.id, accountLogin: value.login, accountType: type }
  }
  private api(path: string, token: string, signal: AbortSignal) {
    return this.request('https://api.github.com' + path, token, undefined, signal)
  }
  private async request(url: string, token: string, body?: Record<string, string>, signal?: AbortSignal): Promise<any> {
    try {
      return await githubRequest({ url, token, json: body, signal })
    } catch {
      throw this.failure(502, 'Unable to read GitHub access; review OAuth organization access and SSO, then reconnect')
    }
  }
}
