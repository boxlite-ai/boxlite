/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  UnauthorizedException,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request, Response } from 'express'
import { Observable, Subscriber, firstValueFrom } from 'rxjs'
import { AUDIT_CONTEXT_KEY, AUDIT_TARGET_ID, AuditContext, AuditTargetId } from '../decorators/audit.decorator'
import { AuditLog, AuditLogMetadata } from '../entities/audit-log.entity'
import { AuditService, PendingAuditLease } from '../services/audit.service'
import { AuthContextType, isAuthContext } from '../../common/interfaces/auth-context.interface'
import { CustomHeaders } from '../../common/constants/header.constants'

type RequestWithUser = Request & {
  user?: AuthContextType
  [AUDIT_TARGET_ID]?: string
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const response = context.switchToHttp().getResponse<Response>()

    const auditContext = this.reflector.get<AuditContext>(AUDIT_CONTEXT_KEY, context.getHandler())

    // Non-audited request
    if (!auditContext || (auditContext.methods && !auditContext.methods.includes(request.method))) {
      return next.handle()
    }

    if (!request.user) {
      this.logger.error('No user context found for audited request:', request.url)
      throw new UnauthorizedException()
    }

    return new Observable((observer) => {
      this.handleAuditedRequest(auditContext, request, response, next, observer)
    })
  }

  // An audit log must be created before the request is passed to the request handler
  // After the request handler returns, the audit log is optimistically updated with the outcome
  private async handleAuditedRequest(
    auditContext: AuditContext,
    request: RequestWithUser,
    response: Response,
    next: CallHandler,
    observer: Subscriber<any>,
  ): Promise<void> {
    try {
      const actor = this.resolveActor(request.user)
      const auditLog = await this.auditService.createLog({
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        organizationId: this.resolveOrganizationId(auditContext, request) ?? actor.organizationId,
        action: auditContext.action,
        targetType: auditContext.targetType,
        targetId: this.resolveTargetId(auditContext, request),
        ipAddress: request.ip,
        userAgent: request.get('user-agent'),
        source: request.get(CustomHeaders.SOURCE.name),
        metadata: this.resolveRequestMetadata(auditContext, request),
      })

      const completeResponse =
        auditContext.completion === 'response'
          ? this.observeResponse(
              auditContext,
              auditLog,
              request,
              response,
              await this.auditService.keepPendingLogAlive(auditLog.id),
            )
          : undefined
      try {
        // A client can disconnect while the initial audit insert is pending.
        if (completeResponse && response.destroyed) {
          completeResponse(0, 'Response closed before completion.')
          observer.next(undefined)
          observer.complete()
          return
        }
        const result = await firstValueFrom(next.handle())

        const organizationId = this.resolveOrganizationId(auditContext, request, result)
        const targetId = this.resolveTargetId(auditContext, request, result)
        const statusCode = response.statusCode || HttpStatus.NO_CONTENT
        if (!completeResponse) await this.recordHandlerSuccess(auditLog, organizationId, targetId, statusCode)

        observer.next(result)
        observer.complete()
      } catch (handlerError) {
        const errorMessage =
          auditContext.errorMessage ??
          (handlerError instanceof HttpException ? handlerError.message : 'An unexpected error occurred.')
        const statusCode = this.resolveErrorStatusCode(handlerError)
        if (completeResponse) {
          completeResponse(statusCode, 'Request failed.')
        } else {
          await this.recordHandlerError(auditLog, errorMessage, statusCode, request[AUDIT_TARGET_ID])
        }

        observer.error(handlerError)
      }
    } catch (createLogError) {
      this.logger.error('Failed to create audit log:', createLogError)
      observer.error(new InternalServerErrorException())
    }
  }

  private observeResponse(
    context: AuditContext,
    log: AuditLog,
    request: RequestWithUser,
    response: Response,
    lease: PendingAuditLease,
  ) {
    let completed = false
    const finish = () => complete(response.statusCode)
    const close = () =>
      complete(
        response.writableFinished ? response.statusCode : 0,
        response.writableFinished ? undefined : 'Response closed before completion.',
      )
    const error = () => complete(0, 'Response failed before completion.')
    const abort = () => {
      complete(0, 'Response audit lease lost.')
      response.destroy()
    }
    const complete = (statusCode: number, errorMessage?: string) => {
      if (completed) return
      // Claim completion and detach before the asynchronous database write.
      completed = true
      response.off('finish', finish)
      response.off('close', close)
      response.off('error', error)
      lease.signal.removeEventListener('abort', abort)
      void lease
        .complete({
          statusCode,
          errorMessage,
          targetId: this.resolveTargetId(context, request),
          organizationId: this.resolveOrganizationId(context, request),
        })
        .catch(() => this.logger.error(`Failed to record response result for audit ${log.id}`))
    }
    response.once('finish', finish)
    response.once('close', close)
    response.once('error', error)
    lease.signal.addEventListener('abort', abort, { once: true })
    if (lease.signal.aborted) abort()
    return complete
  }

  private resolveOrganizationId(auditContext: AuditContext, request: RequestWithUser, result?: any): string | null {
    const requested = auditContext.organizationIdFromRequest?.(request)
    return (
      this.normalizeTargetId(requested) ||
      result?.organizationId ||
      this.resolveActor(request.user).organizationId ||
      null
    )
  }

  /**
   * A caller authenticated through a system API key (proxy, billing, otel
   * collector, ...) has no user identity to audit against — only its role.
   * AuditLog.actorId is NOT NULL with no default, so falling through to
   * `user.userId` for such a caller fails the insert and turns an audited
   * action into a 500 before the handler ever runs. The role name keeps the
   * caller distinguishable in the log instead.
   */
  private resolveActor(user: AuthContextType): { actorId: string; actorEmail: string; organizationId?: string } {
    if (isAuthContext(user)) {
      return { actorId: user.userId, actorEmail: user.email, organizationId: user.organizationId }
    }
    return { actorId: `api-role:${user.role}`, actorEmail: '' }
  }

  /**
   * Resolves the identifier of the target resource from the initial request or the response object.
   *
   * Prioritizes resolving the ID from the response object as the request may not include a unique resource identifier (e.g. delete box by name).
   */
  private resolveTargetId(auditContext: AuditContext, request: RequestWithUser, result?: any): string | null {
    if (request[AUDIT_TARGET_ID]) return request[AUDIT_TARGET_ID]
    if (auditContext.targetIdFromResult && result) {
      const targetId = this.normalizeTargetId(auditContext.targetIdFromResult(result))
      if (targetId) {
        return targetId
      }
    }

    if (auditContext.targetIdFromRequest) {
      const targetId = this.normalizeTargetId(auditContext.targetIdFromRequest(request))
      if (targetId) {
        return targetId
      }
    }

    return null
  }

  private normalizeTargetId(targetId: AuditTargetId): string | null {
    if (Array.isArray(targetId)) {
      return targetId[0] ?? null
    }

    return targetId ?? null
  }

  private resolveRequestMetadata(auditContext: AuditContext, request: RequestWithUser): AuditLogMetadata | null {
    if (!auditContext.requestMetadata) {
      return null
    }

    const resolvedMetadata: AuditLogMetadata = {}

    for (const [key, resolver] of Object.entries(auditContext.requestMetadata)) {
      try {
        resolvedMetadata[key] = resolver(request)
      } catch (error) {
        this.logger.warn(`Failed to resolve audit log metadata key "${key}":`, error)
        resolvedMetadata[key] = null
      }
    }

    return Object.keys(resolvedMetadata).length > 0 ? resolvedMetadata : null
  }

  private async recordHandlerSuccess(
    auditLog: AuditLog,
    organizationId: string | null,
    targetId: string | null,
    statusCode: number,
  ): Promise<void> {
    try {
      await this.auditService.updateLog(auditLog.id, {
        organizationId,
        targetId,
        statusCode,
      })
    } catch (error) {
      this.logger.error('Failed to record handler result:', error)
    }
  }

  private async recordHandlerError(
    auditLog: AuditLog,
    errorMessage: string,
    statusCode: number,
    targetId?: string,
  ): Promise<void> {
    try {
      await this.auditService.updateLog(auditLog.id, {
        errorMessage,
        statusCode,
        ...(targetId ? { targetId } : {}),
      })
    } catch (error) {
      this.logger.error('Failed to record handler error:', error)
    }
  }

  private resolveErrorStatusCode(error: any): number {
    if (error instanceof HttpException) {
      return error.getStatus()
    }

    return HttpStatus.INTERNAL_SERVER_ERROR
  }
}
