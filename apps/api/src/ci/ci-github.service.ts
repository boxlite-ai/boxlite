/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadGatewayException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createPrivateKey } from 'node:crypto'
import { CiGitHubApp, CiGitHubOAuth } from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'
export { CiInstallationRequired } from '@boxlite-ai/ci-listener'
export type { VerifiedInstallation } from '@boxlite-ai/ci-listener'

/** App instances share algorithms; neither a webhook nor a browser chooses another App's secrets. */
@Injectable()
export class CiGitHubService {
  private oauth?: CiGitHubOAuth
  private readonly instances = new Map<string, CiGitHubApp>()
  constructor(private readonly config: TypedConfigService) {}
  get ids(): string[] {
    return ['ci.githubClientId', 'ci.githubOrgClientId']
      .map((key) => this.config.get(key as any) as string)
      .filter(Boolean)
  }
  forType(type: 'User' | 'Organization'): CiGitHubApp {
    const prefix = type === 'User' ? 'ci.github' : 'ci.githubOrg'
    const get = (suffix: string): string | undefined => this.config.get((prefix + suffix) as any) as string | undefined
    const clientId = get('ClientId')
    if (!clientId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId))
      throw new ServiceUnavailableException('GitHub App is not configured')
    if (this.ids.filter((id) => id === clientId).length !== 1)
      throw new ServiceUnavailableException('GitHub App identities must be distinct')
    let app = this.instances.get(clientId)
    if (!app) {
      app = new CiGitHubApp({
        clientId,
        accountType: type,
        slug: get('AppSlug'),
        dashboardUrl: this.config.get('dashboardUrl'),
        privateKey: () => {
          const pem = get('PrivateKey')
          if (typeof pem !== 'string' || Buffer.byteLength(pem) > 65536) throw new Error('Invalid private key size')
          return createPrivateKey(pem)
        },
        clientSecret: () => get('ClientSecret') || '',
        webhookSecret: () => {
          const raw = get('WebhookSecret')
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('Invalid webhook secret size')
          return Buffer.from(raw.trim())
        },
        error: (status, message) =>
          status === 403
            ? new ForbiddenException(message)
            : status === 502
              ? new BadGatewayException(message)
              : new ServiceUnavailableException(message),
      })
      this.instances.set(clientId, app)
    }
    return app
  }
  byClientId(id: string): CiGitHubApp {
    for (const type of ['User', 'Organization'] as const) {
      const key = type === 'User' ? 'ci.githubClientId' : 'ci.githubOrgClientId'
      if (this.config.get(key as any) === id) return this.forType(type)
    }
    throw new ForbiddenException('Original GitHub App is no longer configured')
  }
  configured(): CiGitHubApp[] {
    return this.ids.map((id) => this.byClientId(id))
  }
  identity(): CiGitHubOAuth {
    const clientId = this.config.get('ci.githubOAuthClientId') || ''
    if (!clientId || this.ids.includes(clientId))
      throw new ServiceUnavailableException('A separate GitHub identity OAuth App is required')
    if (this.oauth && this.oauth.clientId !== clientId)
      throw new ServiceUnavailableException('Identity OAuth configuration changed; restart the API')
    return (this.oauth ??= new CiGitHubOAuth({
      clientId,
      clientSecret: () => this.config.get('ci.githubOAuthClientSecret') || '',
      dashboardUrl: this.config.get('dashboardUrl'),
      error: (status, message) =>
        status === 403
          ? new ForbiddenException(message)
          : status === 502
            ? new BadGatewayException(message)
            : new ServiceUnavailableException(message),
    }))
  }
  isIdentityClient(clientId: string): boolean {
    return !!clientId && clientId === this.config.get('ci.githubOAuthClientId') && !this.ids.includes(clientId)
  }
  authorizationApp(clientId: string) {
    return this.isIdentityClient(clientId) ? this.identity() : this.byClientId(clientId)
  }
  async availableAccounts(clientId: string, token: string) {
    if (!this.isIdentityClient(clientId)) throw new ForbiddenException('Original identity OAuth App changed')
    const signal = AbortSignal.timeout(45_000)
    const identity = await this.identity().ownedAccounts(token, signal)
    const apps = new Map(this.configured().map((app) => [app.accountType, app]))
    const owned = identity.accounts.filter((account) => apps.has(account.accountType))
    const accounts: ((typeof owned)[number] & { clientId: string; installationId: number | null })[] = []
    for (let start = 0; start < owned.length; start += 4) {
      accounts.push(
        ...(await Promise.all(
          owned.slice(start, start + 4).map(async (account) => {
            const app = apps.get(account.accountType)!
            const installation = await app.installationFor(account, signal)
            return { ...account, clientId: app.clientId, installationId: installation?.installationId ?? null }
          }),
        )),
      )
    }
    return { user: identity.user, accounts }
  }
  async forAccount(account: string): Promise<CiGitHubApp> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account)) throw new ForbiddenException('Invalid GitHub account')
    const identity = await this.identity().lookupAccount(account)
    return this.forType(identity.accountType)
  }
}
