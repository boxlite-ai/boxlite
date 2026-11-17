/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'
import { defer, finalize, Observable, tap } from 'rxjs'
import { AUDIT_TARGET_ID } from '../../audit/decorators/audit.decorator'
import { requestContext } from '../../common/decorators/user-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { beginBoxOperation } from '../utils/box-operation.util'
import { requestTiming } from '../../common/utils/request-timing.util'

const READINESS_OPERATION = Symbol('readiness_operation')

@Injectable()
export class BoxReadinessInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const kind = this.reflector.get<'create' | 'start'>(READINESS_OPERATION, context.getHandler())
    if (!kind) return next.handle()
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: OrganizationAuthContext
        [AUDIT_TARGET_ID]?: string
      }
    >()
    if (!request.user?.organizationId) return next.handle()
    const finish = beginBoxOperation({
      kind,
      organizationId: request.user.organizationId,
      ctx: requestContext(request),
      scope: 'rest_api',
      timing: requestTiming(request),
    })
    return defer(() => next.handle()).pipe(
      tap({
        next: () => finish({ outcome: 'success', boxId: request[AUDIT_TARGET_ID] }),
        error: (error) => finish({ outcome: 'exception', error, boxId: request[AUDIT_TARGET_ID] }),
      }),
      finalize(() => finish({ outcome: 'cancelled', boxId: request[AUDIT_TARGET_ID] })),
    )
  }
}

/** Only attach to handlers that wait for STARTED before returning success. */
export const ObserveBoxReadiness = (kind: 'create' | 'start') =>
  applyDecorators(SetMetadata(READINESS_OPERATION, kind), UseInterceptors(BoxReadinessInterceptor))
