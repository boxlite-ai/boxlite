/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../config/typed-config.service'

/**
 * The tenant's Management API, reached with the client-credentials grant the
 * `oidc.managementApi` settings describe.
 *
 * Both the account settings page and the login-time link write through it, so
 * the token exchange and URL building live here once rather than in each
 * caller.
 */
@Injectable()
export class Auth0ManagementService {
  private readonly logger = new Logger(Auth0ManagementService.name)

  constructor(private readonly configService: TypedConfigService) {}

  async accessToken(): Promise<string> {
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.configService.getOrThrow('oidc.managementApi.clientId'),
        client_secret: this.configService.getOrThrow('oidc.managementApi.clientSecret'),
        audience: this.configService.getOrThrow('oidc.managementApi.audience'),
      })
      const tokenResponse = await axios.post(this.configService.getOrThrow('oidc.managementApi.tokenUrl'), body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        maxRedirects: 0,
      })
      return tokenResponse.data.access_token
    } catch (error) {
      this.logger.error('Failed to get OIDC Management API token', error?.message || String(error))
      throw new UnauthorizedException()
    }
  }

  url(...pathSegments: string[]): string {
    const path = pathSegments.map(encodeURIComponent).join('/')
    return `${this.configService.getOrThrow('oidc.managementApi.baseUrl')}/${path}`
  }

  /**
   * Record that the address on `userId` is proven.
   *
   * For a password account the account link just signed up: the social
   * provider, or the email Form before it, already proved the address, so
   * asking the person to prove it again would verify nothing new.
   */
  async markEmailVerified(userId: string): Promise<void> {
    const token = await this.accessToken()
    await axios.patch(
      this.url('users', userId),
      { email_verified: true },
      { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 },
    )
  }

  /**
   * Fold `secondaryUserId`'s identity into `primaryUserId`.
   *
   * After this call Auth0 keeps one user: logging in through the secondary
   * identity reaches the primary's record, and the secondary user id stops
   * existing at the tenant.
   */
  async linkIdentity(primaryUserId: string, secondaryUserId: string): Promise<void> {
    const separator = secondaryUserId.indexOf('|')
    if (separator <= 0 || separator === secondaryUserId.length - 1) {
      throw new Error(`not an Auth0 user id: ${secondaryUserId}`)
    }
    const token = await this.accessToken()
    await axios.post(
      this.url('users', primaryUserId, 'identities'),
      {
        provider: secondaryUserId.slice(0, separator),
        user_id: secondaryUserId.slice(separator + 1),
      },
      { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 },
    )
  }
}
