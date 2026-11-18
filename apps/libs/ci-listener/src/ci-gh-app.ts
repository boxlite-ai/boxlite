/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { KeyObject } from 'node:crypto'
import { createGitHubAppJwt, githubRequest, GitHubRequestError } from './github'
import type { GitHubAccount } from './ci-github-oauth'
import { GitHubAppSource } from './github-app'
export interface CiGitHubAppOptions {
  clientId: string
  accountType?: 'User' | 'Organization'
  slug?: string
  privateKey(): KeyObject
  clientSecret?: () => string
  webhookSecret?: () => Buffer
  dashboardUrl?: string
  error?: (status: 403 | 502 | 503, message: string) => Error
}
export class CiGitHubAppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export class CiInstallationRequired extends Error {}
export type VerifiedInstallation = {
  installationId: number
  accountId: number
  accountLogin: string
  accountType: 'User' | 'Organization'
}
export type DeviceGrant = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
export type DevicePoll = { access_token?: string; error?: string }

type Installation = {
  id: number
  account: { id: number; login: string; type: string }
  suspended_at: string | null
  permissions: Record<string, string>
}

export class CiGitHubApp {
  readonly #options: CiGitHubAppOptions
  private source?: GitHubAppSource
  readonly clientId: string
  readonly accountType?: 'User' | 'Organization'
  constructor(options: CiGitHubAppOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.clientId)) throw new Error('Invalid GitHub App identity')
    this.#options = Object.freeze({ ...options })
    this.clientId = options.clientId
    this.accountType = options.accountType
  }
  private failure(status: 403 | 502 | 503, message: string): Error {
    return this.#options.error?.(status, message) ?? new CiGitHubAppError(status, message)
  }
  toJSON(): never {
    throw new Error('GitHub App credentials cannot be serialized')
  }
  secret(): Buffer {
    let secret: Buffer | undefined
    try {
      secret = this.#options.webhookSecret?.()
    } catch {
      throw this.failure(503, 'GitHub webhook secret unavailable')
    }
    if (!Buffer.isBuffer(secret) || secret.length < 32 || secret.length > 256)
      throw this.failure(503, 'GitHub webhook secret unavailable')
    return Buffer.from(secret)
  }

  settings() {
    const clientId = this.clientId
    const slug = this.#options.slug
    const key = this.#options.privateKey
    if (!clientId || !slug || !/^[a-zA-Z0-9-]+$/.test(slug) || !key)
      throw this.failure(503, 'GitHub CI App is not configured')
    return { clientId, installationUrl: `https://github.com/apps/${slug}/installations/new` }
  }

  webSettings() {
    const settings = this.settings()
    const secret = this.#options.clientSecret?.()
    if (
      typeof secret !== 'string' ||
      secret.trim() !== secret ||
      !/^\S{16,4096}$/.test(secret) ||
      secret === settings.clientId
    )
      throw this.failure(503, 'GitHub CI browser authorization is not configured')
    try {
      const base = new URL(this.#options.dashboardUrl || '')
      if (
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/' ||
        (base.protocol !== 'https:' &&
          !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
      )
        throw Error('Invalid callback origin')
      return { ...settings, redirectUri: new URL('/settings/ci/callback', base).href }
    } catch {
      throw this.failure(503, 'GitHub CI browser callback is not configured')
    }
  }

  authorizeWeb(state: string, challenge: string): string {
    const settings = this.webSettings()
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return url.href
  }

  async exchangeWeb(code: string, verifier: string): Promise<string> {
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(verifier))
      throw this.failure(403, 'Invalid GitHub browser authorization')
    const settings = this.webSettings()
    const result = await this.request('https://github.com/login/oauth/access_token', '', {
      client_id: settings.clientId,
      client_secret: this.#options.clientSecret!(),
      code,
      code_verifier: verifier,
      redirect_uri: settings.redirectUri,
    })
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      result.access_token.length > 16384 ||
      result.error
    )
      throw this.failure(403, 'GitHub browser authorization failed; reconnect')
    return result.access_token
  }

  async startDevice(): Promise<DeviceGrant> {
    const result = await this.request('https://github.com/login/device/code', '', {
      client_id: this.settings().clientId,
    })
    if (
      typeof result.device_code !== 'string' ||
      typeof result.user_code !== 'string' ||
      result.verification_uri !== 'https://github.com/login/device' ||
      !Number.isSafeInteger(result.expires_in) ||
      result.expires_in < 1 ||
      !Number.isSafeInteger(result.interval) ||
      result.interval < 1 ||
      result.interval > 60
    )
      throw this.failure(502, 'Invalid GitHub device authorization response; enable Device flow on the App')
    return result as DeviceGrant
  }

  async pollDevice(code: string): Promise<DevicePoll> {
    return this.request('https://github.com/login/oauth/access_token', '', {
      client_id: this.settings().clientId,
      device_code: code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  }

  async verifyUserInstallation(token: string, account: string | number): Promise<VerifiedInstallation> {
    const signal = AbortSignal.timeout(45_000)
    const { user, installations } = await this.userInstallations(token, signal)
    const selected = installations.find((item) =>
      typeof account === 'number' ? item.id === account : item.account.login.toLowerCase() === account.toLowerCase(),
    )
    if (!selected) throw new CiInstallationRequired()
    const owners = selected.account.type === 'Organization' ? await this.organizationOwners(token, signal) : new Map()
    return this.verifyInstallation(user.id, selected, owners, signal)
  }

  async availableInstallations(token: string): Promise<VerifiedInstallation[]> {
    const signal = AbortSignal.timeout(45_000)
    const { user, installations } = await this.userInstallations(token, signal)
    const owners = installations.some((item) => item.account.type === 'Organization')
      ? await this.organizationOwners(token, signal)
      : new Map<number, string>()
    const choices: VerifiedInstallation[] = []
    for (let start = 0; start < installations.length; start += 4) {
      const batch = await Promise.all(
        installations.slice(start, start + 4).map(async (item) => {
          if (item.account.type === 'User' ? item.account.id !== user.id : !owners.has(item.account.id)) return
          try {
            return await this.verifyInstallation(user.id, item, owners, signal)
          } catch (error) {
            if (
              !(error instanceof CiGitHubAppError && error.status === 403) &&
              !(
                error instanceof Error &&
                'getStatus' in error &&
                (error as Error & { getStatus(): number }).getStatus() === 403
              )
            )
              throw error
            return undefined
          }
        }),
      )
      for (const choice of batch) if (choice) choices.push(choice)
    }
    return choices.sort(
      (a, b) => a.accountType.localeCompare(b.accountType) || a.accountLogin.localeCompare(b.accountLogin),
    )
  }

  async installationFor(
    account: GitHubAccount,
    signal = AbortSignal.timeout(45_000),
  ): Promise<VerifiedInstallation | null> {
    this.id(account.accountId)
    if (
      !this.accountType ||
      !['User', 'Organization'].includes(account.accountType) ||
      account.accountType !== this.accountType ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account.accountLogin)
    )
      throw this.failure(403, 'GitHub account does not match the CI App')
    let value: Installation
    try {
      value = (await githubRequest({
        url: `https://api.github.com/${account.accountType === 'User' ? 'users' : 'orgs'}/${encodeURIComponent(account.accountLogin)}/installation`,
        token: await this.appJwt(),
        signal,
      })) as Installation
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) return null
      throw this.failure(502, 'GitHub CI installation lookup failed')
    }
    this.id(value?.id)
    if (
      value.account?.id !== account.accountId ||
      value.account?.type !== account.accountType ||
      typeof value.account?.login !== 'string' ||
      value.account.login.toLowerCase() !== account.accountLogin.toLowerCase() ||
      value.suspended_at !== null ||
      value.permissions?.[account.accountType === 'User' ? 'administration' : 'organization_self_hosted_runners'] !==
        'write'
    )
      throw this.failure(403, 'GitHub CI installation identity, status or permissions denied')
    return { ...account, installationId: value.id }
  }

  private async userInstallations(token: string, signal: AbortSignal) {
    const user = await this.api('/user', token, signal)
    this.id(user.id)
    const seen = new Set<number>(),
      accounts = new Set<number>(),
      installations: Installation[] = []
    let expected = -1
    for (let page = 1; page <= 1000; page++) {
      const batch = await this.api(`/user/installations?per_page=100&page=${page}`, token, signal)
      if (
        !Number.isSafeInteger(batch.total_count) ||
        batch.total_count < 0 ||
        batch.total_count > 1000 ||
        !Array.isArray(batch.installations) ||
        batch.installations.length > 100 ||
        (expected >= 0 && expected !== batch.total_count)
      )
        throw this.failure(502, 'Incomplete GitHub installation inventory')
      expected = batch.total_count
      for (const item of batch.installations as Installation[]) {
        this.id(item.id)
        this.id(item.account?.id)
        if (
          seen.has(item.id) ||
          accounts.has(item.account.id) ||
          typeof item.account.login !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(item.account.login) ||
          !['User', 'Organization'].includes(item.account.type)
        )
          throw this.failure(502, 'Duplicate or invalid GitHub installation')
        seen.add(item.id)
        accounts.add(item.account.id)
        installations.push(item)
      }
      if (seen.size > expected || (batch.installations.length === 0 && seen.size !== expected))
        throw this.failure(502, 'Incomplete GitHub installation inventory')
      if (seen.size === expected) return { user, installations }
    }
    throw this.failure(502, 'GitHub inventory exceeds pagination limit')
  }

  private async verifyInstallation(
    userId: number,
    selected: Installation,
    owners: Map<number, string>,
    signal: AbortSignal,
  ): Promise<VerifiedInstallation> {
    const actual = (await this.api(`/app/installations/${selected.id}`, await this.appJwt(), signal)) as Installation
    if (
      actual.id !== selected.id ||
      actual.account?.id !== selected.account.id ||
      actual.account.type !== selected.account.type ||
      actual.account.login.toLowerCase() !== selected.account.login.toLowerCase() ||
      actual.suspended_at !== null
    )
      throw this.failure(403, 'GitHub installation identity or status denied')
    const type = actual.account.type
    if (this.accountType && type !== this.accountType)
      throw this.failure(403, 'GitHub account type does not match this App')
    if (type === 'User') {
      if (userId !== actual.account.id || actual.permissions?.administration !== 'write')
        throw this.failure(403, 'Personal installation owner and runner administration required')
    } else if (type === 'Organization') {
      if (actual.permissions?.organization_self_hosted_runners !== 'write')
        throw this.failure(403, 'Organization runner administration required')
      if (owners.get(actual.account.id) !== actual.account.login.toLowerCase())
        throw this.failure(403, 'Active GitHub organization owner required')
    } else throw this.failure(403, 'Unsupported GitHub account type')
    return {
      installationId: actual.id,
      accountId: actual.account.id,
      accountLogin: actual.account.login,
      accountType: type,
    }
  }

  private async organizationOwners(token: string, signal: AbortSignal): Promise<Map<number, string>> {
    const owners = new Map<number, string>(),
      seen = new Set<number>()
    for (let page = 1; page <= 1000; page++) {
      const batch = await this.api(`/user/memberships/orgs?state=active&per_page=100&page=${page}`, token, signal)
      if (!Array.isArray(batch) || batch.length > 100) throw this.failure(502, 'Incomplete GitHub membership inventory')
      for (const membership of batch) {
        this.id(membership?.organization?.id)
        const { id, login } = membership.organization
        if (
          seen.has(id) ||
          typeof login !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login) ||
          !['active', 'pending'].includes(membership.state) ||
          !['admin', 'member'].includes(membership.role)
        )
          throw this.failure(502, 'Invalid GitHub membership inventory')
        seen.add(id)
        if (membership.state === 'active' && membership.role === 'admin') owners.set(id, login.toLowerCase())
      }
      if (batch.length < 100) return owners
    }
    throw this.failure(502, 'GitHub membership inventory exceeds pagination limit')
  }

  private id(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw this.failure(502, 'Invalid GitHub identity')
  }

  private async appJwt(): Promise<string> {
    return createGitHubAppJwt(this.settings().clientId, this.signingKey())
  }

  appSource(): GitHubAppSource {
    return (this.source ??= new GitHubAppSource({ issuer: this.clientId, privateKey: () => this.signingKey() }))
  }

  private signingKey(): KeyObject {
    try {
      const key = this.#options.privateKey()
      if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') throw new Error('Private RSA key required')
      return key
    } catch {
      throw this.failure(503, 'GitHub App signing key unavailable')
    }
  }

  private api(path: string, token: string, signal?: AbortSignal) {
    return this.request('https://api.github.com' + path, token, undefined, signal)
  }

  // Fixed origins, bounded responses and no redirects keep credentials out of
  // error pages and attacker-controlled follow-up locations.
  private async request(url: string, token: string, body?: Record<string, string>, signal?: AbortSignal): Promise<any> {
    try {
      return await githubRequest({ url, token, json: body, signal })
    } catch {
      throw this.failure(502, 'GitHub authorization request failed')
    }
  }
}
