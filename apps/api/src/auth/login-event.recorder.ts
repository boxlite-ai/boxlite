/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { recordBusinessEvent } from '../common/utils/business-event.util'

/** The token claims that identify one issued token. */
export interface IssuedToken {
  iat?: number
  exp?: number
}

/**
 * Records `user.login success` the first time the API accepts a newly issued
 * token for a user. Sign-in happens at the identity provider, so this first use
 * is the closest point the API sees; a token refresh issues a new token and
 * records again.
 */
@Injectable()
export class LoginEventRecorder {
  private readonly logger = new Logger(LoginEventRecorder.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async recordFirstUse(userId: string, token: IssuedToken): Promise<void> {
    const secondsUntilExpiry = (token.exp ?? 0) - Math.floor(Date.now() / 1000)
    // Without both claims a token cannot be told apart from the next one.
    if (!token.iat || secondsUntilExpiry <= 0) {
      return
    }

    try {
      const firstUse = await this.redis.set(
        `business-event:user-login:${userId}:${token.iat}`,
        '1',
        'EX',
        secondsUntilExpiry,
        'NX',
      )
      if (firstUse !== 'OK') {
        return
      }
    } catch (error) {
      // A login event must never fail authentication.
      this.logger.warn(`Could not record login event for user ${userId}: ${error}`)
      return
    }

    recordBusinessEvent({ name: 'user.login', outcome: 'success', correlationId: userId, actorKind: 'user' })
  }
}
