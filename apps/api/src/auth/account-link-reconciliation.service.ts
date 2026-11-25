/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkConsentJobs } from './account-link-consent-jobs.service'
import { AccountLinkAuth0Reader } from './account-link-auth0-reader.service'

@Injectable()
export class AccountLinkReconciliation {
  private readonly logger = new Logger(AccountLinkReconciliation.name)

  constructor(
    private readonly jobs: AccountLinkConsentJobs,
    private readonly config: TypedConfigService,
    private readonly auth0: AccountLinkAuth0Reader,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'account-link-consent', waitForCompletion: true })
  async reconcile(): Promise<void> {
    const client = this.config.get('oidc.accountLink.readClient')
    if (!client || this.config.get('skipConnections')) return

    for (let count = 0; count < 5; count++) {
      const [job] = await this.jobs.claim()
      if (!job) return
      try {
        if (await this.auth0.linkExists(job)) {
          await this.jobs.complete(job, 'done', { leaseToken: job.lease_token })
          continue
        }
      } catch {
        // Preserve the pending job on a lookup or commit failure. HTTP errors may contain credentials.
        this.logger.debug(`Could not reconcile account link ${job.id}`)
      }
      await this.jobs.defer(job)
    }
  }
}
