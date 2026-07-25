/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Injectable } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import { InjectThrottlerOptions, InjectThrottlerStorage } from '@nestjs/throttler'
import type { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler'
import { OrganizationService } from '../organization/services/organization.service'
import { getClientIp } from '../common/utils/client-ip.util'

export type BoxliteThrottleDecision = {
  allowed: boolean
  retryAfterSeconds?: number
}

type ResolvedThrottle = {
  name: string
  limit: number
  ttl: number
  blockDuration: number
}

/**
 * Applies the configured Nest throttlers to HTTP-upgrade requests, which
 * bypass the guards used by normal v1 controller requests.
 */
@Injectable()
export class BoxliteRequestThrottleService {
  constructor(
    @InjectThrottlerOptions() private readonly options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly organizationService: OrganizationService,
  ) {}

  async consumeAnonymous(request: IncomingMessage): Promise<BoxliteThrottleDecision> {
    const throttle = this.resolveThrottle('anonymous')
    if (!throttle) {
      return { allowed: true }
    }

    return this.consume(throttle, `anonymous:${getClientIp(request)}`)
  }

  async consumeAuthenticated(organizationId: string): Promise<BoxliteThrottleDecision> {
    const throttle = this.resolveThrottle('authenticated')
    if (!throttle) {
      return { allowed: true }
    }

    const organization = await this.organizationService.findOne(organizationId)
    if (organization?.authenticatedRateLimit != null) {
      throttle.limit = organization.authenticatedRateLimit
    }
    if (organization?.authenticatedRateLimitTtlSeconds != null) {
      throttle.ttl = organization.authenticatedRateLimitTtlSeconds * 1000
      throttle.blockDuration = throttle.ttl
    }

    return this.consume(throttle, `auth:org:${organizationId}`)
  }

  private async consume(throttle: ResolvedThrottle, tracker: string): Promise<BoxliteThrottleDecision> {
    const key = `${throttle.name}-${tracker}`
    const result = await this.storage.increment(
      key,
      throttle.ttl,
      throttle.limit,
      throttle.blockDuration,
      throttle.name,
    )

    return result.isBlocked
      ? { allowed: false, retryAfterSeconds: Math.max(1, result.timeToBlockExpire) }
      : { allowed: true }
  }

  private resolveThrottle(name: string): ResolvedThrottle | null {
    const throttlers = Array.isArray(this.options) ? this.options : this.options.throttlers
    const configured = throttlers.find((throttler) => (throttler.name ?? 'default') === name)
    if (!configured) {
      return null
    }

    const limit = this.numericValue(configured, 'limit')
    const ttl = this.numericValue(configured, 'ttl')
    const blockDuration = configured.blockDuration === undefined ? ttl : this.numericValue(configured, 'blockDuration')

    return { name, limit, ttl, blockDuration }
  }

  private numericValue(config: ThrottlerOptions, field: 'limit' | 'ttl' | 'blockDuration'): number {
    const value = config[field]
    if (typeof value !== 'number') {
      throw new Error(`BoxLite WebSocket throttler ${config.name ?? 'default'} ${field} must be numeric`)
    }
    return value
  }
}
