/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { BoxService } from '../box/services/box.service'
import { BoxState } from '../box/enums/box-state.enum'
import { boxToBoxResponse } from '../boxlite-rest/mappers/box-to-box.mapper'
import { Context } from '../common/context/context'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationService } from '../organization/services/organization.service'
import { AuditService } from '../audit/services/audit.service'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { McpCaller } from './mcp-authorization.service'
import { McpOperation, McpOperationStore } from './mcp-operation.store'
import { McpOutputStore } from './mcp-output.store'

@Injectable()
export class McpOperationsService {
  constructor(
    private readonly store: McpOperationStore,
    private readonly output: McpOutputStore,
    private readonly config: TypedConfigService,
    private readonly boxes: BoxService,
    private readonly organizations: OrganizationService,
    private readonly audit: AuditService,
  ) {}

  async admit(caller: McpCaller, tool: McpOperation['tool'], input: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.config.get('mcp.admissionsEnabled')) throw new ServiceUnavailableException('MCP admissions disabled')
    this.organizations.assertOrganizationIsNotSuspended(caller.organization)
    const { request_id, wait_seconds = 0, ...payload } = input
    if (tool === 'exec_box') await this.findBox(caller, payload.box_id as string)
    const maxActive = this.config.get('mcp.maxActiveOperations')
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 10000)
      throw new ServiceUnavailableException('Invalid MCP capacity configuration')
    let operation = await this.store.reserve(
      { userId: caller.userId, organizationId: caller.organizationId, credential: caller.credential },
      tool,
      request_id as string,
      payload,
      { global: maxActive, runtimeSeconds: tool === 'exec_box' ? (payload.timeout_seconds as number) : 60 },
    )
    const deadline = Date.now() + Math.min(5, Number(wait_seconds)) * 1000
    while (
      ['queued', 'dispatching', 'running'].includes(operation.state) &&
      Date.now() < deadline &&
      !signal?.aborted
    ) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(100, deadline - Date.now()))
        signal?.addEventListener('abort', done, { once: true })
      })
      operation = await this.store.read(caller, operation.id)
    }
    return this.result(caller, operation, tool === 'exec_box' ? 0 : undefined)
  }

  async read(caller: McpCaller, operationId: string, cursor?: number) {
    const operation = await this.store.read(caller, operationId)
    if (cursor !== undefined && operation.tool !== 'exec_box') throw new NotFoundException('Execution not found')
    return this.result(caller, operation, cursor)
  }

  async cancel(caller: McpCaller, operationId: string) {
    const existing = await this.store.read(caller, operationId)
    const log = await this.audit.createLog({
      actorId: caller.userId,
      actorEmail: caller.email,
      organizationId: caller.organizationId,
      targetType: AuditTarget.BOX,
      targetId: existing.box_id ?? undefined,
      source: 'mcp',
      action: AuditAction.STOP,
      metadata: { operation_id: operationId, tool: 'cancel_execution' },
    })
    const operation = await this.store.cancel(caller, operationId)
    await this.audit.updateLog(log.id, { statusCode: 202 })
    return { ...this.summary(operation), cancellation_requested: true }
  }

  async lifecycle(caller: McpCaller, tool: 'stop_box' | 'delete_box', boxId: string) {
    const box = await this.findBox(caller, boxId)
    const log = await this.audit.createLog({
      actorId: caller.userId,
      actorEmail: caller.email,
      organizationId: caller.organizationId,
      targetId: box.id,
      targetType: AuditTarget.BOX,
      source: 'mcp',
      action: tool === 'stop_box' ? AuditAction.STOP : AuditAction.DELETE,
    })
    try {
      if (tool === 'delete_box') await this.boxes.destroy(box.id, caller.organizationId, Context.user())
      else if (![BoxState.STOPPED, BoxState.STOPPING].includes(box.state))
        await this.boxes.stop(box.id, caller.organizationId, Context.user())
      await this.audit.updateLog(log.id, { statusCode: 202 })
      return { box_id: box.id, accepted: true }
    } catch (error) {
      await this.audit.updateLog(log.id, { statusCode: 500 })
      throw error
    }
  }

  private async findBox(caller: McpCaller, id: string) {
    const box = await this.boxes.findOneByIdOrName(id, caller.organizationId)
    if (box.id !== id) throw new NotFoundException('Explicit Box ID required')
    return box
  }

  private async result(caller: McpCaller, operation: McpOperation, cursor?: number) {
    const result: Record<string, unknown> = this.summary(operation)
    if (operation.tool === 'create_box' && operation.box_id) {
      try {
        const box = await this.findBox(caller, operation.box_id)
        result.box = boxToBoxResponse(await this.boxes.toBoxDtoWithExitCode(box))
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error
        result.box = null
      }
    }
    if (cursor !== undefined) {
      try {
        Object.assign(result, await this.output.read(operation, cursor))
      } catch {
        Object.assign(result, { output_status: 'unavailable', output_complete: null })
      }
    }
    return result
  }

  private summary(operation: McpOperation) {
    return {
      operation_id: operation.id,
      tool: operation.tool,
      state: operation.state,
      process_state: operation.process_state,
      collection_state: operation.collection_state,
      box_id: operation.box_id,
      execution_id: operation.execution_id,
      exit_code: operation.exit_code,
      error_code: operation.error_code,
      expires_at: operation.expires_at,
    }
  }
}
