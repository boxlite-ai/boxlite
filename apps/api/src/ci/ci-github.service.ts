/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadGatewayException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createPrivateKey } from 'node:crypto'
import { createGitHubAppJwt, githubRequest, GitHubAppSource } from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'

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

@Injectable()
export class CiGitHubService {
  constructor(private readonly config: TypedConfigService) {}

  settings() {
    const clientId = this.config.get('ci.githubClientId')
    const slug = this.config.get('ci.githubAppSlug')
    const key = this.config.get('ci.githubPrivateKey')
    if (!clientId || !slug || !/^[a-zA-Z0-9-]+$/.test(slug) || !key)
      throw new ServiceUnavailableException('GitHub CI App is not configured')
    return { clientId, installationUrl: `https://github.com/apps/${slug}/installations/new` }
  }

  webSettings() {
    const settings = this.settings()
    const secret = this.config.get('ci.githubClientSecret')
    if (
      typeof secret !== 'string' ||
      secret.trim() !== secret ||
      !/^\S{16,4096}$/.test(secret) ||
      secret === settings.clientId
    )
      throw new ServiceUnavailableException('GitHub CI browser authorization is not configured')
    try {
      const base = new URL(this.config.get('dashboardUrl') || '')
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
      throw new ServiceUnavailableException('GitHub CI browser callback is not configured')
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
      throw new ForbiddenException('Invalid GitHub browser authorization')
    const settings = this.webSettings()
    const result = await this.request('https://github.com/login/oauth/access_token', '', {
      client_id: settings.clientId,
      client_secret: this.config.get('ci.githubClientSecret'),
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
      throw new ForbiddenException('GitHub browser authorization failed; reconnect')
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
      throw new BadGatewayException('Invalid GitHub device authorization response; enable Device flow on the App')
    return result as DeviceGrant
  }

  async pollDevice(code: string): Promise<DevicePoll> {
    return this.request('https://github.com/login/oauth/access_token', '', {
      client_id: this.settings().clientId,
      device_code: code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  }

  async verifyUserInstallation(token: string, account: string): Promise<VerifiedInstallation> {
    const signal = AbortSignal.timeout(45_000)
    const user = await this.api('/user', token, signal)
    this.id(user.id)
    const seen = new Set<number>()
    let expected = -1
    let selected: Installation | undefined
    for (let page = 1; page <= 1000; page++) {
      const batch = await this.api(`/user/installations?per_page=100&page=${page}`, token, signal)
      if (
        !Number.isSafeInteger(batch.total_count) ||
        batch.total_count < 0 ||
        !Array.isArray(batch.installations) ||
        (expected >= 0 && expected !== batch.total_count)
      )
        throw new BadGatewayException('Incomplete GitHub installation inventory')
      expected = batch.total_count
      for (const item of batch.installations as Installation[]) {
        this.id(item.id)
        if (seen.has(item.id)) throw new BadGatewayException('Duplicate GitHub installation')
        seen.add(item.id)
        if (item.account?.login?.toLowerCase() === account.toLowerCase()) {
          if (selected) throw new ForbiddenException('Ambiguous GitHub installation')
          selected = item
        }
      }
      if (seen.size > expected || (batch.installations.length === 0 && seen.size !== expected))
        throw new BadGatewayException('Incomplete GitHub installation inventory')
      if (seen.size === expected) break
      if (page === 1000) throw new BadGatewayException('GitHub inventory exceeds pagination limit')
    }
    if (!selected) throw new CiInstallationRequired()
    this.id(selected.account?.id)
    const actual = (await this.api(`/app/installations/${selected.id}`, await this.appJwt(), signal)) as Installation
    if (
      actual.id !== selected.id ||
      actual.account?.id !== selected.account.id ||
      actual.account.type !== selected.account.type ||
      actual.account.login.toLowerCase() !== account.toLowerCase() ||
      actual.suspended_at !== null
    )
      throw new ForbiddenException('GitHub installation identity or status denied')
    const type = actual.account.type
    if (type === 'User') {
      if (user.id !== actual.account.id || actual.permissions?.administration !== 'write')
        throw new ForbiddenException('Personal installation owner and runner administration required')
    } else if (type === 'Organization') {
      if (actual.permissions?.organization_self_hosted_runners !== 'write')
        throw new ForbiddenException('Organization runner administration required')
      const membership = await this.api(
        `/user/memberships/orgs/${encodeURIComponent(actual.account.login)}`,
        token,
        signal,
      )
      if (
        membership.state !== 'active' ||
        membership.role !== 'admin' ||
        membership.organization?.id !== actual.account.id
      )
        throw new ForbiddenException('Active GitHub organization owner required')
    } else throw new ForbiddenException('Unsupported GitHub account type')
    return {
      installationId: actual.id,
      accountId: actual.account.id,
      accountLogin: actual.account.login,
      accountType: type,
    }
  }

  private id(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new BadGatewayException('Invalid GitHub identity')
  }

  private async appJwt(): Promise<string> {
    return createGitHubAppJwt(this.settings().clientId, this.signingKey())
  }

  appSource(): GitHubAppSource {
    return new GitHubAppSource({ issuer: this.settings().clientId, privateKey: () => this.signingKey() })
  }

  private signingKey() {
    try {
      const pem = this.config.get('ci.githubPrivateKey')
      if (typeof pem !== 'string' || Buffer.byteLength(pem) > 65536) throw new Error('Invalid App key size')
      const key = createPrivateKey(pem)
      if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') throw new Error('Private RSA key required')
      return key
    } catch {
      throw new ServiceUnavailableException('GitHub App signing key unavailable')
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
      throw new BadGatewayException('GitHub authorization request failed')
    }
  }
}
