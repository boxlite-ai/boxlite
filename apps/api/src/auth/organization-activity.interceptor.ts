/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { Request } from 'express'
import { Observable } from 'rxjs'
import { Context } from '../common/context/context'
import { requestActor } from '../common/decorators/user-context.decorator'
import { AuthContextType, isOrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { recordBusinessEvent } from '../common/utils/business-event.util'

type RequestWithUser = Request & {
  user?: AuthContextType
}

// Longer than an hour, so a key outlives the hour it names.
const DEDUPLICATION_SECONDS = 2 * 60 * 60

/**
 * Records `org.active` the first time each UTC hour that a member makes a request
 * in an organization, so their presence there is visible even when the request
 * changes nothing. Only a membership OrganizationAccessGuard has verified counts:
 * a JWT login's organizationId is the client's header, unchecked on routes without
 * the guard, and an admin acting in an organization is not a member. Hours rather
 * than days: an hour never straddles midnight in a whole-hour time zone, so every
 * local day with a request shows it. It never delays or fails the request.
 */
@Injectable()
export class OrganizationActivityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OrganizationActivityInterceptor.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<RequestWithUser>()
      void this.record(request)
    }
    return next.handle()
  }

  private async record(request: RequestWithUser): Promise<void> {
    const user = request.user
    const actor = requestActor(request)
    const membership = user && isOrganizationAuthContext(user) ? user.organizationUser : undefined
    if (!actor || !membership) {
      return
    }
    const hour = new Date().toISOString().slice(0, 13)
    try {
      const first = await this.redis.set(
        `business-event:org-active:${membership.organizationId}:${actor.userId}:${hour}`,
        '1',
        'EX',
        DEDUPLICATION_SECONDS,
        'NX',
      )
      if (first !== 'OK') {
        return
      }
    } catch (error) {
      this.logger.warn(`Could not record organization activity for user ${actor.userId}: ${error}`)
      return
    }
    recordBusinessEvent({
      name: 'org.active',
      outcome: 'success',
      correlationId: actor.userId,
      organizationId: membership.organizationId,
      ctx: Context.user(actor),
    })
  }
}
