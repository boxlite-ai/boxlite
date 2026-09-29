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
}
