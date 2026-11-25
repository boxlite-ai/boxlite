/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../config/typed-config.service'
import type { AccountLinkOperation } from './account-link-consent-jobs.service'

@Injectable()
export class AccountLinkAuth0Reader {
  private token?: { value: string; validUntil: number }

  constructor(private readonly config: TypedConfigService) {}

  async linkExists(job: AccountLinkOperation): Promise<boolean> {
    const client = this.config.getOrThrow('oidc.accountLink.readClient')
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
    if (
      data.user_id !== job.target_id ||
      !Array.isArray(data.identities) ||
      data.identities.length === 0 ||
      data.identities.some((identity) => typeof identity?.provider !== 'string' || typeof identity.user_id !== 'string')
    ) {
      throw new Error('Auth0 did not return the expected target profile')
    }
    return data.identities.some(({ provider, user_id }) => `${provider}|${user_id}` === job.source_id)
  }
}
