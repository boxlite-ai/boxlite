/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { UserService } from '../user/user.service'

/** The audiences the Action signs its requests for, one per endpoint. */
export const ADOPT_AUDIENCE = 'boxlite-account-link-adopt'
export const STATUS_AUDIENCE = 'boxlite-account-link-status'

/** Who an adopt request names. */
export interface AdoptRequest {
  primaryUserId: string
  secondaryUserId: string
}

// An Auth0 user id: the provider, a bar, and the provider's own id.
const USER_ID = /^[^|\s]+\|\S+$/

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID.test(value)
}

/**
 * The API's part of the login-time account link, which merges a person's
 * logins into one account.
 *
 * The Post-Login Action proves the person holds both accounts and links them
 * inside Auth0. The step it cannot take is moving BoxLite's rows, so it asks
 * here first, with an HS256 token signed by the shared secret that names both
 * users and lives for a minute. Moving before the link keeps a failed link
 * retryable: the next login asks again, and moving is idempotent. Before it
 * decides which account stays, or what Cancel does, it asks whether BoxLite
 * knows a user already.
 */
@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly linkedIdentity: LinkedIdentityService,
    private readonly userService: UserService,
  ) {}

  /** Move the BoxLite data of the user the token names to the account that stays. */
  async adopt(token: string): Promise<AdoptRequest> {
    const payload = await this.readRequest(token, ADOPT_AUDIENCE)
    const secondaryUserId = payload.sub
    const primaryUserId = payload.primary_user_id
    if (!isUserId(primaryUserId) || primaryUserId === secondaryUserId) {
      throw new UnauthorizedException('The account-link request does not name two accounts.')
    }
    await this.linkedIdentity.adopt(primaryUserId, secondaryUserId)
    this.logger.log(`Moved ${secondaryUserId}'s BoxLite data to ${primaryUserId} for an account link`)
    return { primaryUserId, secondaryUserId }
  }

  /** Whether BoxLite has the user the token names, that is, whether it has signed in before. */
  async status(token: string): Promise<{ known: boolean }> {
    const { sub } = await this.readRequest(token, STATUS_AUDIENCE)
    return { known: (await this.userService.findOne(sub)) !== null }
  }

  private async readRequest(token: string, audience: string): Promise<Record<string, unknown> & { sub: string }> {
    const key = new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.secret'))
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience,
        requiredClaims: ['sub', 'iat', 'exp'],
        maxTokenAge: '60s',
        // The Action runs on Auth0's clock, not this host's.
        clockTolerance: 5,
      }))
    } catch {
      throw new UnauthorizedException('The account-link request is not valid.')
    }
    const sub = payload.sub
    if (!isUserId(sub)) {
      throw new UnauthorizedException('The account-link request does not name an account.')
    }
    return { ...payload, sub }
  }
}
