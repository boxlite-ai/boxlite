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
  BadRequestException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request, Response } from 'express'
import { Observable, Subscriber, firstValueFrom } from 'rxjs'
import { AUDIT_CONTEXT_KEY, AuditContext, AuditTargetId } from '../decorators/audit.decorator'
import { AuditLog, AuditLogMetadata } from '../entities/audit-log.entity'
import { AuditAction } from '../enums/audit-action.enum'
import { AuditService } from '../services/audit.service'
import { AuthContextType, isAuthContext } from '../../common/interfaces/auth-context.interface'
import { CustomHeaders } from '../../common/constants/header.constants'
import { TypedConfigService } from '../../config/typed-config.service'
import { BackofficeAuditHeaders, BOXLITE_BACKOFFICE_USER_ID } from '../../common/constants/backoffice.constants'

type RequestWithUser = Request & {
  user?: AuthContextType
}

type AuditActor = {
  actorId: string
  actorEmail: string
  organizationId?: string
  metadata?: AuditLogMetadata
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
    private readonly configService: TypedConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const response = context.switchToHttp().getResponse<Response>()

    const auditContext = this.reflector.get<AuditContext>(AUDIT_CONTEXT_KEY, context.getHandler())

    // Non-audited request
    if (!auditContext) {
      return next.handle()
    }

    // Toolbox requests are not audited by default
    if (this.isToolboxAction(auditContext.action) && !this.configService.get('audit.toolboxRequestsEnabled')) {
      return next.handle()
    }

    if (!request.user) {
      this.logger.error('No user context found for audited request:', request.url)
      throw new UnauthorizedException()
    }

    const actor = this.resolveActor(request.user, request)

    return new Observable((observer) => {
      this.handleAuditedRequest(auditContext, actor, request, response, next, observer)
    })
  }

  // An audit log must be created before the request is passed to the request handler
  // After the request handler returns, the audit log is optimistically updated with the outcome
  private async handleAuditedRequest(
    auditContext: AuditContext,
    actor: AuditActor,
    request: RequestWithUser,
    response: Response,
    next: CallHandler,
    observer: Subscriber<any>,
  ): Promise<void> {
    try {
      const auditLog = await this.auditService.createLog({
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        organizationId: actor.organizationId,
        action: auditContext.action,
        targetType: auditContext.targetType,
        targetId: this.resolveTargetId(auditContext, request),
        ipAddress: request.ip,
        userAgent: request.get('user-agent'),
        source: request.get(CustomHeaders.SOURCE.name),
        metadata: this.resolveRequestMetadata(auditContext, request, actor.metadata),
      })

      try {
        const result = await firstValueFrom(next.handle())

        const organizationId = this.resolveOrganizationId(actor, result)
        const targetId = this.resolveTargetId(auditContext, request, result)
        const statusCode = response.statusCode || HttpStatus.NO_CONTENT
        await this.recordHandlerSuccess(auditLog, organizationId, targetId, statusCode)

        observer.next(result)
        observer.complete()
      } catch (handlerError) {
        const errorMessage =
          handlerError instanceof HttpException ? handlerError.message : 'An unexpected error occurred.'
        const statusCode = this.resolveErrorStatusCode(handlerError)
        await this.recordHandlerError(auditLog, errorMessage, statusCode)

        observer.error(handlerError)
      }
    } catch (createLogError) {
      this.logger.error('Failed to create audit log:', createLogError)
      observer.error(new InternalServerErrorException())
    }
  }

  private resolveOrganizationId(actor: AuditActor, result?: any): string | null {
    return result?.organizationId || actor.organizationId || null
  }

  /**
   * A caller authenticated through a system API key (proxy, billing, otel
   * collector, ...) has no user identity to audit against — only its role.
   * AuditLog.actorId is NOT NULL with no default, so falling through to
   * `user.userId` for such a caller fails the insert and turns an audited
   * action into a 500 before the handler ever runs. The role name keeps the
   * caller distinguishable in the log instead.
   */
  private resolveActor(user: AuthContextType, request: RequestWithUser): AuditActor {
    if (isAuthContext(user)) {
      if (user.userId === BOXLITE_BACKOFFICE_USER_ID && user.apiKey?.name === BOXLITE_BACKOFFICE_USER_ID) {
        const actorId = this.requireDelegatedValue(
          request,
          BackofficeAuditHeaders.ACTOR_SUBJECT,
          255,
          /^[A-Za-z0-9._:@|/-]+$/,
        )
        const actorEmail = this.requireDelegatedValue(
          request,
          BackofficeAuditHeaders.ACTOR_EMAIL,
          320,
          /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/,
        )
        const sessionId = this.requireDelegatedValue(
          request,
          BackofficeAuditHeaders.SESSION_ID,
          200,
          /^[A-Za-z0-9._:@/-]+$/,
        )
        const correlationId = this.requireDelegatedValue(
          request,
          BackofficeAuditHeaders.CORRELATION_ID,
          128,
          /^[A-Za-z0-9._:@/-]+$/,
        )
        return {
          actorId,
          actorEmail,
          organizationId: user.organizationId,
          metadata: {
            serviceActor: BOXLITE_BACKOFFICE_USER_ID,
            delegatedBy: BOXLITE_BACKOFFICE_USER_ID,
            backofficeSessionId: sessionId,
            correlationId,
          },
        }
      }
      return { actorId: user.userId, actorEmail: user.email, organizationId: user.organizationId }
    }
    return { actorId: `api-role:${user.role}`, actorEmail: '' }
  }

  private requireDelegatedValue(request: RequestWithUser, header: string, maxLength: number, pattern: RegExp): string {
    const value = request.get(header)
    if (!value || value.length > maxLength || !/^[\x20-\x7E]+$/.test(value) || !pattern.test(value)) {
      throw new BadRequestException('Invalid delegated audit context')
    }
    return value
  }

  /**
   * Resolves the identifier of the target resource from the initial request or the response object.
   *
   * Prioritizes resolving the ID from the response object as the request may not include a unique resource identifier (e.g. delete box by name).
   */
  private resolveTargetId(auditContext: AuditContext, request: RequestWithUser, result?: any): string | null {
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

  private resolveRequestMetadata(
    auditContext: AuditContext,
    request: RequestWithUser,
    actorMetadata?: AuditLogMetadata,
  ): AuditLogMetadata | null {
    const resolvedMetadata: AuditLogMetadata = { ...actorMetadata }

    for (const [key, resolver] of Object.entries(auditContext.requestMetadata ?? {})) {
      try {
        resolvedMetadata[key] = resolver(request)
      } catch (error) {
        this.logger.warn(`Failed to resolve audit log metadata key "${key}":`, error)
        resolvedMetadata[key] = null
      }
    }

    return Object.keys(resolvedMetadata).length > 0 ? resolvedMetadata : null
  }

  private isToolboxAction(action: AuditAction): boolean {
    return action.startsWith('toolbox_')
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

  private async recordHandlerError(auditLog: AuditLog, errorMessage: string, statusCode: number): Promise<void> {
    try {
      await this.auditService.updateLog(auditLog.id, {
        errorMessage,
        statusCode,
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
