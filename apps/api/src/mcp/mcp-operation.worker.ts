/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { StringDecoder } from 'node:string_decoder'
import { BoxService } from '../box/services/box.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxCreationAdmissionUnavailableError } from '../box/errors/box-creation-limit.error'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { createBoxToCreateBox } from '../boxlite-rest/mappers/box-to-box.mapper'
import { CreateBoxDto } from '../boxlite-rest/dto/create-box.dto'
import { Context } from '../common/context/context'
import { EncryptionService } from '../encryption/encryption.service'
import { OrganizationService } from '../organization/services/organization.service'
import { AuditService } from '../audit/services/audit.service'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { McpAuthorizationService } from './mcp-authorization.service'
import { McpOperation, McpOperationStore } from './mcp-operation.store'
import { McpOutputStore } from './mcp-output.store'
import { McpCommand, McpRunnerClient } from './mcp-runner.client'

@Injectable()
export class McpOperationWorker implements OnModuleDestroy {
  private readonly logger = new Logger(McpOperationWorker.name)
  private readonly active = new Map<AbortController, Promise<void>>()
  private polling?: Promise<void>
  private stopping = false

  constructor(
    private readonly store: McpOperationStore,
    private readonly output: McpOutputStore,
    private readonly authorization: McpAuthorizationService,
    private readonly boxes: BoxService,
    private readonly autoResume: BoxAutoResumeService,
    private readonly commerce: CommerceBoxLimitService,
    private readonly organizations: OrganizationService,
    private readonly encryption: EncryptionService,
    private readonly runner: McpRunnerClient,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND, { name: 'mcp-operations', waitForCompletion: true })
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (!this.polling) {
      this.polling = this.poll().finally(() => {
        this.polling = undefined
      })
    }
    return this.polling
  }

  private async poll(): Promise<void> {
    try {
      await this.store.expire()
      while (!this.stopping && this.active.size < 8) {
        const operation = await this.store.claim()
        if (!operation) break
        if (this.stopping) {
          await this.store.releaseClaim(operation)
          break
        }
        const abort = new AbortController()
        const done = this.run(operation, abort)
          .catch(() => {
            // Never log the exception: runner/SQL errors may contain payloads.
            this.logger.warn(`MCP operation ${operation.id} ended without a durable result`)
          })
          .finally(() => this.active.delete(abort))
        this.active.set(abort, done)
      }
    } catch {
      this.logger.warn('MCP operation storage unavailable')
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true
    for (const abort of this.active.keys()) abort.abort()
    await this.polling
    await Promise.allSettled(this.active.values())
  }

  private async run(operation: McpOperation, abort: AbortController): Promise<void> {
    let dispatchAttempted = operation.state === 'running' || operation.state === 'outcome_unknown'
    let boxId = operation.box_id
    let executionId = operation.execution_id
    let dispatchSaved = dispatchAttempted
    let auditId: string | undefined
    let cancelled = false
    let cancellation: Promise<void> | undefined
    let outputStarted = operation.state === 'running' && operation.tool === 'exec_box'
    let heartbeatBusy = false
    let renewAt = 0
    let leaseExpires = Date.now() + 13000
    let activityAt = 0
    let activityInterval = 5000
    const cleaningUp = Boolean(operation.cancel_requested && boxId && executionId)
    const deadline = setTimeout(
      () => abort.abort(),
      cleaningUp ? 30000 : Math.max(1, operation.deadline_at.getTime() - Date.now()),
    )
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || abort.signal.aborted) return
      heartbeatBusy = true
      void (async () => {
        if (Date.now() >= renewAt) {
          const expires = Date.now() + 13000
          if (!(await this.store.renew(operation))) throw new Error('Lease lost')
          leaseExpires = expires
          if (outputStarted) await this.output.lease(operation, expires)
          renewAt = Date.now() + 5000
          if (!cleaningUp && !cancellation) {
            const current = await this.store.read(operation.identity, operation.id)
            if (current.cancel_requested && boxId && executionId) {
              // A slow routing/kill request must not stop lease renewal.
              cancellation = (async () => {
                const box = await this.boxes.findOneByIdOrName(boxId, operation.organization_id)
                if (abort.signal.aborted) throw new Error('Cancellation lease lost')
                await this.runner.cancel(box, executionId)
                cancelled = true
                abort.abort()
              })()
              void cancellation.catch(() => abort.abort())
            }
          }
        }
        if (boxId && Date.now() >= activityAt) {
          await this.boxes.updateLastActivityAt(boxId, new Date())
          activityAt = Date.now() + activityInterval
        }
      })()
        .catch(() => abort.abort())
        .finally(() => {
          heartbeatBusy = false
        })
    }, 250)
    try {
      if (cleaningUp) {
        const box = await this.boxes.findOneByIdOrName(boxId, operation.organization_id)
        if (abort.signal.aborted || !(await this.store.renew(operation))) throw new Error('Cancellation lease lost')
        await this.runner.cancel(box, executionId)
        cancelled = true
        throw new Error('Cancellation acknowledged')
      }
      if (operation.state === 'dispatching') {
        // Authority gates new effects; expiry must not prevent collecting or
        // terminating an execution whose original dispatch was authorized.
        let caller = await this.authorization.authorize(operation.identity, 'boxes:write')
        this.organizations.assertOrganizationIsNotSuspended(caller.organization)
        const input = JSON.parse(await this.encryption.decrypt(operation.payload!))
        const log = await this.audit.createLog({
          actorId: caller.userId,
          actorEmail: caller.email,
          organizationId: caller.organizationId,
          action: operation.tool === 'create_box' ? AuditAction.CREATE : AuditAction.TOOLBOX_EXECUTE_COMMAND,
          targetType: AuditTarget.BOX,
          source: 'mcp',
          metadata: { operation_id: operation.id, tool: operation.tool },
        })
        auditId = log.id
        if (operation.tool === 'create_box') {
          const maxCreatedBoxes = await this.commerce.resolveMaxCreatedBoxes(caller.organizationId)
          caller = await this.authorization.authorize(operation.identity, 'boxes:write')
          if (abort.signal.aborted || !(await this.store.renew(operation))) throw new Error('Dispatch lease lost')
          dispatchAttempted = true
          const box = await this.boxes
            .create(createBoxToCreateBox(input as CreateBoxDto), caller.organization, Context.user(), {
              maxCreatedBoxes,
            })
            .catch((error) => {
              // These typed admission failures precede Box persistence. Unknown
              // errors (including DTO lookup 404s) can occur after commit.
              if (
                (error instanceof HttpException && [400, 403, 409, 429].includes(error.getStatus())) ||
                error instanceof BoxCreationAdmissionUnavailableError
              )
                dispatchAttempted = false
              throw error
            })
          boxId = box.id
          if (
            !(await this.store.save(operation, {
              state: 'running',
              process_state: 'not_started',
              collection_state: 'not_applicable',
              box_id: boxId,
            }))
          )
            return
          dispatchSaved = true
        } else {
          const command = input as McpCommand
          let box = await this.boxes.findOneByIdOrName(command.box_id, caller.organizationId)
          if (box.id !== command.box_id) throw new Error('Explicit Box ID required')
          boxId = box.id
          activityInterval = box.autoStop > 0 ? Math.max(250, Math.min(5000, box.autoStop * 500)) : 5000
          await this.boxes.updateLastActivityAt(box.id, new Date())
          if (box.autoResume) await this.autoResume.ensureReady(box.id, caller.organization)
          box = await this.boxes.findOneByIdOrName(box.id, caller.organizationId)
          caller = await this.authorization.authorize(operation.identity, 'boxes:write')
          this.organizations.assertOrganizationIsNotSuspended(caller.organization)
          if ((await this.store.read(operation.identity, operation.id)).cancel_requested) {
            cancelled = true
            throw new Error('Cancelled before dispatch')
          }
          const leaseUntil = Date.now() + 13000
          if (abort.signal.aborted || !(await this.store.renew(operation))) throw new Error('Dispatch lease lost')
          leaseExpires = leaseUntil
          await this.output.lease(operation, leaseUntil, true)
          outputStarted = true
          dispatchAttempted = true
          executionId = await this.runner.start(box, command, abort.signal)
          if (
            !(await this.store.save(operation, {
              state: 'running',
              process_state: 'running',
              collection_state: 'collecting',
              box_id: box.id,
              execution_id: executionId,
            }))
          )
            return
          dispatchSaved = true
        }
      }
      if (operation.tool === 'create_box') {
        while (!abort.signal.aborted) {
          const box = await this.boxes.findOneByIdOrName(boxId!, operation.organization_id).catch((error) => {
            if (error instanceof NotFoundException) return null
            throw error
          })
          if (!box || [BoxState.ERROR, BoxState.DESTROYED, BoxState.DESTROYING].includes(box.state)) {
            await this.store.save(operation, {
              state: 'failed',
              process_state: 'not_started',
              collection_state: 'not_applicable',
              box_id: boxId,
              error_code: 'box_creation_failed',
            })
            return
          }
          if (box.state === BoxState.STARTED) {
            await this.store.save(operation, {
              state: 'succeeded',
              process_state: 'not_started',
              collection_state: 'not_applicable',
              box_id: box.id,
            })
            return
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250)
            timer.unref()
          })
        }
        throw new Error('Creation interrupted')
      }
      const box = await this.boxes.findOneByIdOrName(boxId!, operation.organization_id)
      activityInterval = box.autoStop > 0 ? Math.max(250, Math.min(5000, box.autoStop * 500)) : 5000
      await this.output.lease(operation, leaseExpires)
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const exitCode = await this.runner.collect(box, executionId!, abort.signal, async (stream, bytes) => {
        await this.output.append(operation, stream, decoders[stream].write(bytes))
      })
      for (const stream of ['stdout', 'stderr'] as const)
        await this.output.append(operation, stream, decoders[stream].end())
      await this.output.finish(operation)
      await this.store.save(operation, {
        state: 'succeeded',
        process_state: 'exited',
        collection_state: 'finished',
        exit_code: exitCode,
      })
    } catch {
      if (cancellation) {
        try {
          await cancellation
          cancelled = true
        } catch {
          /* A failed kill does not prove process exit. */
        }
      }
      if (dispatchSaved && !cancelled && operation.deadline_at.getTime() > Date.now()) {
        if (boxId && executionId && !this.stopping) {
          try {
            const box = await this.boxes.findOneByIdOrName(boxId, operation.organization_id)
            const status = await this.runner.status(box, executionId)
            if (status.status !== 'running') {
              await this.output.finish(operation).catch(() => undefined)
              await this.store.save(operation, {
                state: 'succeeded',
                process_state: 'exited',
                collection_state: 'interrupted',
                exit_code: status.exit_code,
              })
              return
            }
          } catch {
            /* The next lease may recover routing or storage. */
          }
        }
        await this.store.release(operation)
        return
      }
      // A lost reply after dispatch is never treated as permission to retry.
      if (outputStarted) await this.output.finish(operation).catch(() => undefined)
      await this.store.save(operation, {
        state: cancelled ? 'cancelled' : dispatchAttempted ? 'outcome_unknown' : 'failed',
        process_state: cancelled && executionId ? 'exited' : dispatchAttempted ? 'unknown' : 'not_started',
        collection_state: outputStarted ? 'interrupted' : 'unavailable',
        box_id: boxId ?? undefined,
        execution_id: executionId ?? undefined,
        error_code: cancelled ? undefined : dispatchAttempted ? 'outcome_unknown' : 'dispatch_rejected',
      })
    } finally {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      if (auditId)
        await this.audit.updateLog(auditId, { statusCode: dispatchAttempted ? 202 : 403, targetId: boxId ?? undefined })
    }
  }
}
