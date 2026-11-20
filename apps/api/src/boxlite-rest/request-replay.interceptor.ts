/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
  OnModuleDestroy,
  StreamableFile,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { catchError, Observable, of } from 'rxjs'
import { BoxRequestReplayService, ReplayResource, REPLAY_HEARTBEAT_MS } from './box-request-replay.service'
import { replayIdentity, replayPolicy, REPLAY_ONLY, REPLAY_RESOURCE, validateReplayKey } from './request-replay-policy'
import { captureReplayResponse } from './request-replay-response'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { hasNoEffect } from '../common/replay-no-effect'
import { AUDIT_TARGET_ID } from '../audit/decorators/audit.decorator'
import { RESPONSE_PASSTHROUGH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum'

type ReplayRequest = Request & {
  user?: OrganizationAuthContext
  [AUDIT_TARGET_ID]?: string
  [REPLAY_ONLY]?: boolean
  [REPLAY_RESOURCE]?: ReplayResource
}

@Injectable()
export class RequestReplayInterceptor implements NestInterceptor, OnModuleDestroy {
  private readonly logger = new Logger(RequestReplayInterceptor.name)
  private readonly active = new Set<() => void>()
  constructor(private readonly service: BoxRequestReplayService) {}
  onModuleDestroy(): void {
    for (const cleanup of this.active) cleanup()
    this.active.clear()
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle()
    const req = context.switchToHttp().getRequest<ReplayRequest>()
    const route = String(req.route?.path ?? req.path)
    const policy = replayPolicy(req.method, route)
    if (policy === 'outside' || policy === 'read') return next.handle()
    const key = validateReplayKey(req)
    if (!key) return next.handle()
    if (policy === 'excluded') throw new BadRequestException('Idempotency-Key is not supported for this operation')
    const user = req.user
    if (!user?.organizationId || !user.userId) throw new ForbiddenException('Organization authentication required')
    const prefix = req.params?.prefix
    if (prefix && prefix !== 'default' && prefix !== user.organizationId)
      throw new ForbiddenException('Request prefix does not match organization')
    const identity = replayIdentity(req)
    if (
      identity.operation === 'createBox' &&
      Array.isArray(req.body?.volumes) &&
      req.body.volumes.length &&
      !hasOrganizationResourcePermissions(user, [
        OrganizationResourcePermission.READ_VOLUMES,
        OrganizationResourcePermission.WRITE_VOLUMES,
      ])
    ) {
      throw new ForbiddenException('Attaching a managed volume requires: read:volumes, write:volumes')
    }
    if (
      (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) &&
      req.headers['content-type']?.split(';')[0] !== 'application/json'
    )
      throw new BadRequestException('Idempotency-Key requires a JSON request body')
    const session = await this.service.session(
      user.organizationId,
      user.userId,
      identity.operation,
      key,
      identity.fingerprint,
      { replayOnly: req[REPLAY_ONLY] },
    )
    const response = context.switchToHttp().getResponse<Response>()
    if (session.response) {
      const stored = session.response
      if (stored.auditTargetId) req[AUDIT_TARGET_ID] = stored.auditTargetId
      response.status(stored.status)
      for (const [name, value] of Object.entries(stored.headers ?? { 'content-type': 'application/json' }))
        response.setHeader(name, value)
      // Nest writes ordinary return values itself; @Res/@Next handlers own their response.
      const metadata: Record<string, unknown> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, context.getClass(), context.getHandler().name) ?? {}
      const passthrough = Reflect.getMetadata(
        RESPONSE_PASSTHROUGH_METADATA,
        context.getClass(),
        context.getHandler().name,
      )
      const handled =
        !passthrough &&
        Object.keys(metadata).some((key) =>
          [RouteParamtypes.RESPONSE, RouteParamtypes.NEXT].includes(Number(key.split(':')[0])),
        )
      const body =
        stored.status === 204 ? undefined : Buffer.from(stored.body, stored.encoding === 'base64' ? 'base64' : 'utf8')
      if (handled) {
        response.end(body)
        return of(undefined)
      }
      return of(body === undefined ? undefined : new StreamableFile(body))
    }
    const logFailure = (error: unknown): void =>
      this.logger.warn(
        `Failed to save replay outcome for ${identity.operation}: ${error instanceof Error ? error.message : 'storage error'}`,
      )
    let stopped = false
    let beating = false
    const timer = setInterval(() => {
      if (beating || stopped) return
      beating = true
      void session
        .heartbeat()
        .catch(logFailure)
        .finally(() => {
          beating = false
        })
    }, REPLAY_HEARTBEAT_MS)
    timer.unref()
    const stop = (): void => {
      stopped = true
      clearInterval(timer)
      this.active.delete(cleanup)
    }
    let cleanup!: () => void
    const captureCleanup = captureReplayResponse(
      response,
      (result) => {
        void session
          .complete({ ...result, resource: req[REPLAY_RESOURCE], auditTargetId: req[AUDIT_TARGET_ID] })
          .catch(logFailure)
        this.active.delete(cleanup)
      },
      () => {
        void session.markUnknown().catch(logFailure)
      },
      stop,
    )
    cleanup = () => {
      captureCleanup()
      this.active.delete(cleanup)
    }
    this.active.add(cleanup)
    return next.handle().pipe(
      catchError(async (error: unknown) => {
        cleanup()
        try {
          if (hasNoEffect(error)) await session.markRetryable()
          else await session.markUnknown()
        } catch (storageError) {
          logFailure(storageError)
        }
        throw error
      }),
    )
  }
}
