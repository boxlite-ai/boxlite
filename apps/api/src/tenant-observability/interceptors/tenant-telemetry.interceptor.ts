/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { trace } from '@opentelemetry/api'
import { Request, Response } from 'express'
import { PinoLogger } from 'nestjs-pino'
import { Observable } from 'rxjs'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'

type TelemetryRequest = Request & { user?: Partial<OrganizationAuthContext> }

@Injectable()
export class TenantTelemetryInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle()
    }

    const request = context.switchToHttp().getRequest<TelemetryRequest>()
    const response = context.switchToHttp().getResponse<Response>()
    const fields = this.getFields(request)
    const span = trace.getActiveSpan()

    if (Object.keys(fields).length > 1) {
      span?.setAttributes(fields)
      this.logger.assign(fields)
    }

    const traceId = span?.spanContext().traceId
    if (traceId) {
      response.setHeader('x-trace-id', traceId)
    }

    return next.handle()
  }

  private getFields(request: TelemetryRequest): Record<string, string> {
    const fields: Record<string, string> = { 'boxlite.source': 'api' }
    const organizationId = this.getTrustedOrganizationId(request.user)
    if (!organizationId) {
      return fields
    }

    this.add(fields, 'boxlite.organization.id', organizationId)
    this.add(fields, 'boxlite.runner.id', request.params?.runnerId)
    this.add(fields, 'boxlite.box.id', request.params?.boxId || request.params?.boxIdOrName)
    this.add(fields, 'boxlite.job.id', request.params?.jobId)
    return fields
  }

  private getTrustedOrganizationId(user?: Partial<OrganizationAuthContext>): string | undefined {
    if (
      typeof user?.organizationId !== 'string' ||
      user.organization?.id !== user.organizationId ||
      (user.role !== SystemRole.ADMIN && user.organizationUser?.organizationId !== user.organizationId)
    ) {
      return undefined
    }
    return user.organizationId
  }

  private add(fields: Record<string, string>, key: string, value: unknown): void {
    if (typeof value === 'string' && value.length > 0) {
      fields[key] = value
    }
  }
}
