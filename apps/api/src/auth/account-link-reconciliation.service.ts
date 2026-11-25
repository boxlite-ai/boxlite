/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkConsentJobs } from './account-link-consent-jobs.service'
import type { AccountLinkOperation } from './account-link-consent-jobs.service'

@Injectable()
export class AccountLinkReconciliation {
  private readonly logger = new Logger(AccountLinkReconciliation.name)
  private token?: { value: string; validUntil: number }

  constructor(
    private readonly jobs: AccountLinkConsentJobs,
    private readonly config: TypedConfigService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'account-link-consent', waitForCompletion: true })
  async reconcile(): Promise<void> {
    const client = this.config.get('oidc.accountLink.readClient')
    if (!client || this.config.get('skipConnections')) return

    for (let count = 0; count < 5; count++) {
      const [job] = await this.jobs.claim()
      if (!job) return
      try {
        if (await this.linkExists(job, client)) {
          await this.jobs.complete(job, 'done', job.lease_token)
          continue
        }
      } catch {
        // Preserve the pending job on a lookup or commit failure. HTTP errors may contain credentials.
        this.logger.debug(`Could not reconcile account link ${job.id}`)
      }
      await this.jobs.defer(job)
    }
  }

  private async linkExists(job: AccountLinkOperation, client: { id: string; secret: string }): Promise<boolean> {
    const base = this.config.getOrThrow('oidc.managementApi.baseUrl')
    const tokenUrl = this.config.getOrThrow('oidc.managementApi.tokenUrl')
    if (!this.token || this.token.validUntil <= Date.now()) {
      const audience = this.config.get('oidc.managementApi.audience') || `${base}/`
      const { data } = await axios.post<{ access_token: string; expires_in: number }>(
        tokenUrl,
        { grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret, audience },
        { timeout: 5000, maxRedirects: 0 },
      )
      this.token = { value: data.access_token, validUntil: Date.now() + Math.max(0, data.expires_in - 60) * 1000 }
    }
    const { data } = await axios.get<{ user_id: string; identities?: { provider: string; user_id: string }[] }>(
      `${base}/users/${encodeURIComponent(job.target_id)}`,
      { headers: { Authorization: `Bearer ${this.token.value}` }, timeout: 5000, maxRedirects: 0 },
    )
    return (
      data.user_id === job.target_id &&
      (data.identities?.some(({ provider, user_id }) => `${provider}|${user_id}` === job.source_id) ?? false)
    )
  }
}
