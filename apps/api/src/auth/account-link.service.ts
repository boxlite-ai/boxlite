/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'

/** The audience the Action signs its adopt requests for. */
export const ADOPT_AUDIENCE = 'boxlite-account-link-adopt'

/** Who an adopt request names. */
export interface AdoptRequest {
  primaryUserId: string
  socialUserId: string
}

/**
 * The API's part of the login-time account link (POL-555).
 *
 * The Post-Login Action checks the password and links the identities inside
 * Auth0. The step it cannot take is moving BoxLite's rows, so it asks here
 * first, with an HS256 token signed by the shared secret that names both users
 * and lives for a minute. Moving before the link keeps a failed link
 * retryable: the next social login asks again, and moving is idempotent.
 */
@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly linkedIdentity: LinkedIdentityService,
  ) {}

  /** Move the social user's BoxLite data to the password account the token names. */
  async adopt(token: string): Promise<AdoptRequest> {
    const request = await this.readAdoptRequest(token)
    await this.linkedIdentity.adopt(request.primaryUserId, request.socialUserId)
    this.logger.log(`Moved ${request.socialUserId}'s BoxLite data to ${request.primaryUserId} for an account link`)
    return request
  }

  private async readAdoptRequest(token: string): Promise<AdoptRequest> {
    const key = new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.secret'))
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience: ADOPT_AUDIENCE,
        requiredClaims: ['sub', 'iat', 'exp'],
        maxTokenAge: '60s',
        // The Action runs on Auth0's clock, not this host's.
        clockTolerance: 5,
      }))
    } catch {
      throw new UnauthorizedException('The account-link request is not valid.')
    }
    const socialUserId = payload.sub
    const primaryUserId = payload.primary_user_id
    // Only a social identity folds into a database account: an auth0| subject
    // on the social side, or anything else on the primary side, is refused.
    if (
      typeof socialUserId !== 'string' ||
      typeof primaryUserId !== 'string' ||
      socialUserId.startsWith('auth0|') ||
      !primaryUserId.startsWith('auth0|')
    ) {
      throw new UnauthorizedException('The account-link request does not name a social and a password account.')
    }
    return { primaryUserId, socialUserId }
  }
}
