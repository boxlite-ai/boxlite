/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, Injectable, Logger } from '@nestjs/common'
import { AuditService } from '../../../audit/services/audit.service'
import { AuditAction } from '../../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../../audit/enums/audit-target.enum'
import type { OrganizationAuthContext } from '../../../common/interfaces/auth-context.interface'
import { assertMcpActive } from './mcp-tool'

@Injectable()
export class McpToolAudit {
  private readonly logger = new Logger(McpToolAudit.name)

  constructor(private readonly audit: AuditService) {}

  async run<T>(
    auth: OrganizationAuthContext,
    operation: {
      tool: string
      action: AuditAction
      targetType: AuditTarget
      targetId?: string
      resultTargetId?: (result: T) => string
    },
    effect: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    assertMcpActive(signal)
    const log = await this.audit.createLog({
      actorId: auth.userId,
      actorEmail: auth.email,
      organizationId: auth.organizationId,
      action: operation.action,
      targetType: operation.targetType,
      targetId: operation.targetId,
      source: 'mcp',
      metadata: { tool: operation.tool },
    })
    let statusCode = 500
    let targetId = operation.targetId
    try {
      assertMcpActive(signal)
      const result = await effect()
      targetId = operation.resultTargetId?.(result) ?? targetId
      statusCode = 200
      return result
    } catch (error) {
      statusCode = signal?.aborted ? 499 : error instanceof HttpException ? error.getStatus() : 500
      throw error
    } finally {
      // A failed outcome update must not invite a retry of an effect that already completed.
      await this.audit.updateLog(log.id, { statusCode, targetId }).catch(() => {
        this.logger.warn('MCP audit outcome update failed')
      })
    }
  }
}
