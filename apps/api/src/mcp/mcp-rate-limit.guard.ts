/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ExecutionContext, Injectable } from '@nestjs/common'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'

@Injectable()
export class McpRateLimitGuard extends AuthenticatedRateLimitGuard {
  protected getThrottlerScopes(context: ExecutionContext): string[] {
    const body = context.switchToHttp().getRequest().body
    if (body?.method !== 'tools/call') return []
    if (body.params?.name === 'create_box') return ['box-create']
    return ['stop_box', 'delete_box'].includes(body.params?.name) ? ['box-lifecycle'] : []
  }
}
