/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import * as ipaddr from 'ipaddr.js'
import { Request } from 'express'
import { TypedConfigService } from '../config/typed-config.service'

const CONSUME = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`

@Injectable()
export class RegistrationRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RegistrationRateLimitGuard.name)

  constructor(
    @InjectRedis('throttler') private readonly redis: Redis,
    private readonly config: TypedConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const settings = this.config.getOrThrow('rateLimit.registration')
    let count: number, remainingMs: number
    try {
      const ip = ipaddr.process(request.ip ?? '').toString()
      ;[count, remainingMs] = (await this.redis.eval(
        CONSUME,
        1,
        `boxlite:registration:ip:${ip}`,
        settings.ttl * 1000,
      )) as [number, number]
    } catch {
      this.logger.warn({ event: 'registration.rate_limit', outcome: 'unavailable' })
      throw new ServiceUnavailableException({
        code: 'registration_rate_limit_unavailable',
        message: 'Registration is temporarily unavailable',
      })
    }
    if (count > settings.limit) {
      this.logger.warn({ event: 'registration.rate_limit', outcome: 'limited' })
      throw Object.assign(
        new HttpException(
          {
            code: 'registration_rate_limited',
            message: 'Too many registration attempts. Try again later.',
          },
          429,
        ),
        { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) },
      )
    }
    return true
  }
}
