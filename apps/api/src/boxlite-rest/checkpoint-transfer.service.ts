/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import axios, { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Request, Response } from 'express'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { DataSource, In, IsNull, LessThan, Not } from 'typeorm'
import { validate as isUuid } from 'uuid'
import { Box } from '../box/entities/box.entity'
import {
  BoxCheckpoint,
  BoxCheckpointOperation,
  BoxCheckpointTransfer,
  CloudCheckpointInspection,
} from '../box/entities/box-checkpoint.entity'
import { Region } from '../region/entities/region.entity'
import { Runner } from '../box/entities/runner.entity'
import { RunnerState } from '../box/enums/runner-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxService } from '../box/services/box.service'
import { BoxCheckpointService, checkpointName, checkpointNativeError } from '../box/services/box-checkpoint.service'
import { BoxRepository } from '../box/repositories/box.repository'
import { assertNoSnapshotOperation } from '../box/utils/box-state.util'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CheckpointBoxService } from './checkpoint-box.service'

const MAX_TRANSFER_BYTES = 16 * 1024 ** 3

/** Server-issued transfer records are the only source of runner staging identities. */
@Injectable()
export class CheckpointTransferService {
  private readonly logger = new Logger(CheckpointTransferService.name)
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly checkpoints: BoxCheckpointService,
    private readonly children: CheckpointBoxService,
    private readonly boxes: BoxService,
    private readonly repository: BoxRepository,
  ) {}

  async import(auth: OrganizationAuthContext, request: Request, name?: string) {
    this.checkpoints.requireStorage()
    if (name !== undefined) checkpointName(name)
    const runner = await this.selectRunner(auth)
    const transfer = await this.reserve(auth.organizationId, runner.id, 'upload')
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    try {
      let received = 0
      const bound = new Transform({
        transform(chunk, _, callback) {
          received += chunk.length
          callback(
            received > MAX_TRANSFER_BYTES ? new BadRequestException('Checkpoint upload exceeds 16 GiB') : null,
            chunk,
          )
        },
      })
      request.on('error', (error) => bound.destroy(error))
      request.pipe(bound)
      const inspected = this.validateInspection(
        await this.call<CloudCheckpointInspection>(runner, transfer.id, {
          method: 'POST',
          data: bound,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Organization-Id': auth.organizationId },
          maxBodyLength: MAX_TRANSFER_BYTES,
        }),
      )
      const checkpointId = randomUUID()
      await this.source.transaction(async (manager) => {
        const lease = await manager.findOne(BoxCheckpointTransfer, {
          where: { id: transfer.id, state: 'staging' },
          lock: { mode: 'pessimistic_write' },
        })
        if (!lease || lease.expiresAt <= new Date())
          throw new ConflictException('Checkpoint transfer expired before registration')
        const boot = await manager.findOne(BoxCheckpoint, {
          where: {
            organizationId: auth.organizationId,
            state: 'ready',
            bootDiskSha256: inspected.boot_disk_sha256,
            archiveUri: Not(''),
          },
          lock: { mode: 'pessimistic_read' },
        })
        // Hold a trusted boot archive through registration: native owns its verified
        // copy before resource deletion may acquire the exclusive lock.
        const registered = await this.call<{ checkpointId: string }>(runner, transfer.id, {
          method: 'POST',
          url: 'register',
          data: {
            organizationId: auth.organizationId,
            operationId: transfer.id,
            expectedPairSha256: inspected.pair_sha256,
            ...(boot?.archiveUri ? { bootArchiveUri: boot.archiveUri } : {}),
          },
        })
        if (!isUuid(registered.checkpointId))
          throw new ServiceUnavailableException('Runner returned an invalid checkpoint identity')
        await manager.insert(BoxCheckpoint, {
          id: checkpointId,
          organizationId: auth.organizationId,
          name: `transfer-${transfer.id}`,
          sourceBoxId: '',
          region: runner.region,
          state: 'ready',
          visible: false,
          archiveUri: '',
          nativeCheckpointId: registered.checkpointId,
          nativeRunnerId: runner.id,
          contentSha256: inspected.pair_sha256,
          bootDiskSha256: inspected.boot_disk_sha256,
          configuration: inspected.configuration,
          cpus: inspected.resources.cpus,
          memoryMib: inspected.resources.memory_mib,
          diskGb: Math.ceil(inspected.container_disk_bytes / 1024 ** 3),
          sizeBytes: inspected.memory_file_bytes + inspected.qcow2_bytes + inspected.boot_disk_bytes,
        })
        await manager.update(
          BoxCheckpointTransfer,
          { id: transfer.id },
          { inspection: inspected, checkpointId, nativeCheckpointId: registered.checkpointId, state: 'registered' },
        )
      })
      const child = await this.children.create(
        auth,
        await this.source.getRepository(BoxCheckpoint).findOneByOrFail({ id: checkpointId }),
        name,
      )
      await this.source
        .getRepository(BoxCheckpointTransfer)
        .update(transfer.id, { state: 'consumed', targetBoxId: child.box_id })
      return child
    } catch (error) {
      await this.source.getRepository(BoxCheckpointTransfer).update(transfer.id, { state: 'cleanup' })
      throw error
    } finally {
      request.off('aborted', abort)
      await this.cleanup(transfer.id).catch((error) =>
        this.logger.warn(`Transfer ${transfer.id} awaits cleanup: ${error.message}`),
      )
    }
  }

  async export(auth: OrganizationAuthContext, selector: string, request: Request, response: Response): Promise<void> {
    this.checkpoints.requireStorage()
    const selected = await this.boxes.findOneByIdOrName(selector, auth.organizationId)
    const transfer = await this.reserve(auth.organizationId, selected.runnerId, 'export', selected.id)
    const controller = new AbortController()
    const abort = () => {
      if (!response.writableFinished) controller.abort()
    }
    response.once('close', abort)
    try {
      const runner = await this.checkpoints.requireRunner(this.source.manager, transfer.runnerId)
      const stream = await this.call<NodeJS.ReadableStream>(runner, transfer.id, {
        method: 'POST',
        url: 'export',
        data: { boxId: selected.id, operationId: transfer.id, organizationId: auth.organizationId },
        responseType: 'stream',
        signal: controller.signal,
      })
      response.status(200).type('application/octet-stream')
      await pipeline(stream, response)
    } finally {
      response.off('close', abort)
      await this.source.getRepository(BoxCheckpointTransfer).update(transfer.id, { state: 'cleanup' })
      await this.cleanup(transfer.id).catch((error) =>
        this.logger.warn(`Export ${transfer.id} awaits cleanup: ${error.message}`),
      )
    }
  }

  private async selectRunner(auth: OrganizationAuthContext): Promise<Runner> {
    const regions = await this.source
      .getRepository(Region)
      .find({ where: [{ organizationId: auth.organizationId }, { organizationId: IsNull() }] })
    const runner = regions.length
      ? await this.source.getRepository(Runner).findOne({
          where: {
            region: In(regions.map((region) => region.id)),
            apiVersion: '2',
            checkpointsEnabled: true,
            state: RunnerState.READY,
            unschedulable: false,
            draining: false,
          },
          order: { availabilityScore: 'DESC' },
        })
      : null
    if (runner) return runner
    throw new ServiceUnavailableException('No compatible checkpoint runner is available in an authorized region')
  }

  private async reserve(
    organizationId: string,
    runnerId: string,
    kind: 'upload' | 'export',
    boxId?: string,
  ): Promise<BoxCheckpointTransfer> {
    return this.source.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [0x4354524e, organizationId])
      await this.checkpoints.requireRunner(manager, runnerId)
      if ((await manager.count(BoxCheckpointTransfer, { where: { organizationId } })) >= 10)
        throw new ConflictException('Too many checkpoint transfers are pending')
      const transfer = manager.create(BoxCheckpointTransfer, {
        id: randomUUID(),
        organizationId,
        runnerId,
        kind,
        state: 'staging',
        targetBoxId: boxId ?? null,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      if (boxId) {
        const box = await manager.findOne(Box, {
          where: { id: boxId, organizationId },
          lock: { mode: 'pessimistic_write' },
          loadEagerRelations: false,
        })
        if (!box) throw new ConflictException('Source box was removed')
        assertNoSnapshotOperation(box)
        if (box.state !== BoxState.PAUSED || box.desiredState !== BoxDesiredState.PAUSED || box.pending)
          throw new ConflictException('Box must be paused and idle before export')
        await this.repository.updateWhere(
          box.id,
          {
            updateData: { checkpointOperationId: transfer.id },
            whereCondition: { state: BoxState.PAUSED, pending: false },
          },
          manager,
        )
      }
      await manager.insert(BoxCheckpointTransfer, transfer)
      return transfer
    })
  }

  private validateInspection(value: CloudCheckpointInspection): CloudCheckpointInspection {
    const configuration = value?.configuration,
      resources = value?.resources
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((item) => typeof item === 'string')
    const optionalStrings = (v: unknown) => v == null || strings(v)
    if (
      value?.version !== 1 ||
      !configuration ||
      !resources ||
      !/^[0-9a-f]{64}$/.test(value.pair_sha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(value.boot_disk_sha256 ?? '') ||
      ![
        resources.cpus,
        resources.memory_mib,
        resources.max_cpus,
        resources.max_memory_mib,
        value.memory_file_bytes,
        value.qcow2_bytes,
        value.container_disk_bytes,
        value.boot_disk_bytes,
        value.memory_file_bytes + value.qcow2_bytes + value.boot_disk_bytes,
      ].every((v) => Number.isSafeInteger(v) && v > 0) ||
      resources.cpus > resources.max_cpus ||
      resources.memory_mib > resources.max_memory_mib ||
      typeof configuration.image !== 'string' ||
      !configuration.image ||
      !Array.isArray(configuration.env) ||
      !configuration.env.every((pair) => strings(pair) && pair.length === 2) ||
      !optionalStrings(configuration.entrypoint) ||
      !optionalStrings(configuration.cmd) ||
      (configuration.working_dir != null && typeof configuration.working_dir !== 'string') ||
      (configuration.user != null && typeof configuration.user !== 'string') ||
      typeof configuration.tty !== 'boolean' ||
      typeof configuration.privileged !== 'boolean' ||
      !['enabled', 'disabled'].includes(configuration.outbound?.mode) ||
      !strings(configuration.outbound?.allow_net ?? []) ||
      !['enabled', 'disabled'].includes(configuration.inbound?.mode)
    ) {
      throw new ServiceUnavailableException('Runner returned an invalid checkpoint inspection')
    }
    return {
      version: value.version,
      pair_sha256: value.pair_sha256,
      boot_disk_sha256: value.boot_disk_sha256,
      memory_file_bytes: value.memory_file_bytes,
      qcow2_bytes: value.qcow2_bytes,
      container_disk_bytes: value.container_disk_bytes,
      boot_disk_bytes: value.boot_disk_bytes,
      resources: {
        cpus: resources.cpus,
        memory_mib: resources.memory_mib,
        max_cpus: resources.max_cpus,
        max_memory_mib: resources.max_memory_mib,
      },
      configuration: {
        image: configuration.image,
        env: configuration.env.map(([key, value]) => [key, value]),
        working_dir: configuration.working_dir,
        user: configuration.user,
        entrypoint: configuration.entrypoint,
        cmd: configuration.cmd,
        tty: configuration.tty,
        privileged: configuration.privileged,
        outbound: { mode: configuration.outbound.mode, allow_net: configuration.outbound.allow_net ?? [] },
        inbound: { mode: configuration.inbound.mode },
      },
    }
  }

  private async call<T>(runner: Runner, id: string, options: AxiosRequestConfig): Promise<T> {
    if (!runner.apiUrl) throw new ServiceUnavailableException('Runner has no checkpoint transfer endpoint')
    const suffix = options.url ? `/${options.url}` : ''
    try {
      const result = await axios.request<T>({
        timeout: 120_000,
        maxRedirects: 0,
        ...options,
        url: `${runner.apiUrl.replace(/\/$/, '')}/api/checkpoint-transfers/${id}${suffix}`,
        headers: { ...options.headers, Authorization: `Bearer ${runner.apiKey}` },
      })
      return result.data
    } catch (error) {
      const upstream = error.response
      let body = upstream?.data
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of body) {
          length += chunk.length
          if (length > 64 * 1024) {
            body.destroy()
            throw new ServiceUnavailableException('Checkpoint runner returned an oversized error')
          }
          chunks.push(Buffer.from(chunk))
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
      }
      const translated = checkpointNativeError(body?.error)
      if (translated && translated.getStatus() === upstream.status) throw translated
      throw new ServiceUnavailableException('Checkpoint runner transfer failed')
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'checkpoint-transfer-cleanup' })
  async reap(): Promise<void> {
    const transfers = await this.source
      .getRepository(BoxCheckpointTransfer)
      .find({ where: [{ state: In(['cleanup', 'consumed']) }, { expiresAt: LessThan(new Date()) }], take: 100 })
    for (const transfer of transfers)
      await this.cleanup(transfer.id).catch((error) =>
        this.logger.warn(`Transfer ${transfer.id} cleanup failed: ${error.message}`),
      )
  }

  private async cleanup(id: string): Promise<void> {
    const transfer = await this.source.transaction(async (manager) => {
      const lease = await manager.findOne(BoxCheckpointTransfer, { where: { id }, lock: { mode: 'pessimistic_write' } })
      if (!lease || (['staging', 'registered'].includes(lease.state) && lease.expiresAt > new Date())) return null
      if (lease.checkpointId) {
        // BoxRepository holds a shared resource lock until its target insert commits.
        // Close admission under the opposite lock before asking native to unlink.
        const checkpoint = await manager.findOne(BoxCheckpoint, {
          where: { id: lease.checkpointId },
          lock: { mode: 'pessimistic_write' },
        })
        if (
          (await manager.exists(Box, { where: { initialCheckpointId: lease.checkpointId } })) ||
          (await manager.exists(BoxCheckpointOperation, {
            where: { checkpointId: lease.checkpointId, state: 'pending' },
          }))
        )
          return null
        if (checkpoint) await manager.update(BoxCheckpoint, checkpoint.id, { state: 'deleting' })
      }
      await manager.update(BoxCheckpointTransfer, id, { state: 'cleanup' })
      return lease
    })
    if (!transfer) return
    const runner = await this.source.getRepository(Runner).findOneByOrFail({ id: transfer.runnerId })
    // Runner DELETE acknowledges only after native completion; failure retains this durable lease.
    await this.call(runner, transfer.id, { method: 'DELETE' })
    await this.source.transaction(async (manager) => {
      if (transfer.kind === 'export' && transfer.targetBoxId) {
        const box = await manager.findOneBy(Box, { id: transfer.targetBoxId, checkpointOperationId: transfer.id })
        if (box)
          await this.repository.updateWhere(
            box.id,
            { updateData: { checkpointOperationId: null }, whereCondition: { checkpointOperationId: transfer.id } },
            manager,
          )
      }
      if (transfer.checkpointId) await manager.delete(BoxCheckpoint, { id: transfer.checkpointId, visible: false })
      await manager.delete(BoxCheckpointTransfer, { id })
    })
  }
}
