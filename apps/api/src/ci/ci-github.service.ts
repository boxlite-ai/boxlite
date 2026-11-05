/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadGatewayException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createPrivateKey } from 'node:crypto'
import { CiGitHubApp, githubRequest } from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'
export { CiInstallationRequired } from '@boxlite-ai/ci-listener'
export type { VerifiedInstallation } from '@boxlite-ai/ci-listener'

/** App instances share algorithms; neither a webhook nor a browser chooses another App's secrets. */
@Injectable()
export class CiGitHubService {
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
  async forAccount(account: string): Promise<CiGitHubApp> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account)) throw new ForbiddenException('Invalid GitHub account')
    const value = (await githubRequest({
      url: 'https://api.github.com/users/' + encodeURIComponent(account),
      token: '',
    })) as { login?: string; type?: string }
    if (value.login?.toLowerCase() !== account.toLowerCase() || !['User', 'Organization'].includes(value.type || ''))
      throw new ForbiddenException('GitHub account identity unavailable')
    return this.forType(value.type as 'User' | 'Organization')
  }
}
