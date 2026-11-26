/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import type { EntityManager } from 'typeorm'
import { BoxRepository } from '../../repositories/box.repository'
import { Box } from '../../entities/box.entity'
import { Runner } from '../../entities/runner.entity'
import { BoxState } from '../../enums/box-state.enum'
import { DONT_SYNC_AGAIN, BoxAction, SYNC_AGAIN, SyncState } from './box.action'
import { RunnerState } from '../../enums/runner-state.enum'
import { RunnerService } from '../../services/runner.service'
import { RunnerAdapterFactory } from '../../runner-adapter/runnerAdapter'
import { OrganizationService } from '../../../organization/services/organization.service'
import { TypedConfigService } from '../../../config/typed-config.service'
import { LockCode, RedisLockProvider } from '../../common/redis-lock.provider'
import { WithSpan } from '../../../common/decorators/otel.decorator'
import { BoxActivityService } from '../../services/box-activity.service'
import { CuratedImagePinService } from '../../../image/services/curated-image-pin.service'
import { boxImageIsOrgOwned } from '../../utils/image-ownership.util'

import { resolveNestedVirtualization } from '../../runner-adapter/nested-virtualization-policy'
import { ManagedOutboundBootstrap } from '../../services/managed-outbound-bootstrap'
import { UNCONFIRMED_PROTECTED_PLACEHOLDER } from '../../errors/protected-placeholder.error'

@Injectable()
export class BoxStartAction extends BoxAction {
  protected readonly logger = new Logger(BoxStartAction.name)
  constructor(
    protected runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected boxRepository: BoxRepository,
    protected readonly organizationService: OrganizationService,
    protected readonly configService: TypedConfigService,
    protected readonly redisLockProvider: RedisLockProvider,
    private readonly boxActivityService: BoxActivityService,
    private readonly curatedImagePins: CuratedImagePinService,
    private readonly outboundBootstrap?: ManagedOutboundBootstrap,
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode): Promise<SyncState> {
    if (box.prevRunnerId && (await this.outboundBootstrap?.isProtected(box))) {
      const previous = await this.runnerService.findOne(box.prevRunnerId)
      if (!previous || previous.state !== RunnerState.READY) return DONT_SYNC_AGAIN
      const adapter = await this.runnerAdapterFactory.create(previous)
      if (!(await this.outboundBootstrap.retire(box, adapter, 'previous'))) return DONT_SYNC_AGAIN
      return this.handleRunnerBoxUnknownStateOnDesiredStateStart(box, lockCode)
    }
    switch (box.state) {
      case BoxState.UNKNOWN: {
        return this.handleRunnerBoxUnknownStateOnDesiredStateStart(box, lockCode)
      }
      case BoxState.STOPPED: {
        return this.handleRunnerBoxStoppedStateOnDesiredStateStart(box, lockCode)
      }
      case BoxState.RESTORING:
      case BoxState.CREATING:
      case BoxState.STARTING: {
        return this.handleRunnerBoxStartedStateCheck(box, lockCode)
      }
      case BoxState.ERROR: {
        this.logger.error(`Box ${box.id} is in error state on desired state start`)
        return DONT_SYNC_AGAIN
      }
    }

    return DONT_SYNC_AGAIN
  }

  private async handleRunnerBoxUnknownStateOnDesiredStateStart(box: Box, lockCode: LockCode): Promise<SyncState> {
    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    if (runner.state !== RunnerState.READY) {
      return DONT_SYNC_AGAIN
    }

    if (!box.image) {
      await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, 'Box has no image to create from')
      return DONT_SYNC_AGAIN
    }

    const organization = await this.organizationService.findOne(box.organizationId)

    const metadata: { [key: string]: string } = { ...organization?.boxMetadata }
    if (box.volumes?.length) {
      metadata['volumes'] = JSON.stringify(
        box.volumes.map((v) => ({ volumeId: v.volumeId, mountPath: v.mountPath, subpath: v.subpath })),
      )
    }

    // A tenant's image was pinned by the resolver when the box was created. A
    // curated one keeps its tag on the box — the warm pool matches on it — and
    // is pinned here instead, to the build this runner already booted.
    const image = boxImageIsOrgOwned(box) ? box.image : await this.curatedImagePins.refFor(runner.id, box.image)

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    const nested = await resolveNestedVirtualization(
      box.organizationId,
      this.organizationService,
      runnerAdapter,
      this.configService.getOrThrow('runnerHealthTimeout') * 1000,
    )
    const protectedStart = await this.outboundBootstrap?.start(box, runnerAdapter, { image, metadata, nested })
    if (protectedStart === 'allocation-unconfirmed') {
      await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, UNCONFIRMED_PROTECTED_PLACEHOLDER)
      return DONT_SYNC_AGAIN
    }
    if (protectedStart === 'pending' || protectedStart === 'managed-stopped') return DONT_SYNC_AGAIN
    if (protectedStart !== 'ready') await runnerAdapter.createBox(box, image, metadata, nested, undefined, lockCode)

    await this.updateBoxState(box, BoxState.CREATING, lockCode)
    return SYNC_AGAIN
  }

  private async handleRunnerBoxStoppedStateOnDesiredStateStart(box: Box, lockCode: LockCode): Promise<SyncState> {
    const organization = await this.organizationService.findOne(box.organizationId)

    //  A stopped box restarts on its own runner. Cross-runner recovery is not supported.
    if (box.runnerId === null) {
      await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, 'Box has no runner')
      return DONT_SYNC_AGAIN
    }

    const runner = await this.runnerService.findOneOrFail(box.runnerId)

    if (runner.state !== RunnerState.READY) {
      return DONT_SYNC_AGAIN
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    const protectedStart = await this.outboundBootstrap?.start(box, runnerAdapter)
    if (protectedStart === 'pending' || protectedStart === 'managed-stopped') return DONT_SYNC_AGAIN

    const metadata: { [key: string]: string } = { ...organization?.boxMetadata }
    if (box.volumes?.length) {
      metadata['volumes'] = JSON.stringify(
        box.volumes.map((v) => ({ volumeId: v.volumeId, mountPath: v.mountPath, subpath: v.subpath })),
      )
    }

    if (protectedStart !== 'ready') await runnerAdapter.startBox(box.id, box.authToken, metadata, undefined, lockCode)

    await this.updateBoxState(box, BoxState.STARTING, lockCode)
    return SYNC_AGAIN
  }

  //  used to check if box is started on runner and update box state accordingly
  //  also used to handle the case where a box is started on a runner and then transferred to a new runner
  private async handleRunnerBoxStartedStateCheck(box: Box, lockCode: LockCode): Promise<SyncState> {
    //  edge case when box is being transferred to a new runner
    if (!box.runnerId) {
      return SYNC_AGAIN
    }

    const runner = await this.runnerService.findOneOrFail(box.runnerId)

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    if ((await this.outboundBootstrap?.start(box, runnerAdapter)) === 'pending') return DONT_SYNC_AGAIN
    const boxInfo = await runnerAdapter.boxInfo(box.id)

    switch (boxInfo.state) {
      case BoxState.STARTED: {
        await this.updateBoxState(box, BoxState.STARTED, lockCode, undefined, undefined, boxInfo.daemonVersion)

        if (box.prevRunnerId) {
          await this.boxRepository.cleanupPreviousRunner(box, (runnerId, manager) =>
            this.removeBoxFromPreviousRunner(box.id, runnerId, manager),
          )
        }

        return DONT_SYNC_AGAIN
      }
      case BoxState.STARTING:
        if (await this.checkTimeoutError(box, 5, 'Timeout while starting box')) {
          return DONT_SYNC_AGAIN
        }
        break
      case BoxState.RESTORING:
        if (await this.checkTimeoutError(box, 30, 'Timeout while starting box')) {
          return DONT_SYNC_AGAIN
        }
        break
      case BoxState.CREATING: {
        if (await this.checkTimeoutError(box, 15, 'Timeout while creating box')) {
          return DONT_SYNC_AGAIN
        }
        break
      }
      case BoxState.UNKNOWN: {
        await this.updateBoxState(box, BoxState.UNKNOWN, lockCode)
        break
      }
      case BoxState.ERROR: {
        await this.updateBoxState(
          box,
          BoxState.ERROR,
          lockCode,
          undefined,
          'Box entered error state on runner during startup wait loop',
        )
        break
      }
      case BoxState.DESTROYED: {
        this.logger.warn(
          `Box ${box.id} is in destroyed state while starting on runner ${box.runnerId}, prev runner ${box.prevRunnerId}`,
        )
        await this.checkTimeoutError(box, 15, 'Timeout while starting box: Box is in unknown state on runner')
        return DONT_SYNC_AGAIN
      }
      // also any other state that is not STARTED
      default: {
        this.logger.error(`Box ${box.id} is in unexpected state ${boxInfo.state}`)
        await this.updateBoxState(
          box,
          BoxState.ERROR,
          lockCode,
          undefined,
          `Box is in unexpected state: ${boxInfo.state}`,
        )
        break
      }
    }

    return SYNC_AGAIN
  }

  private async checkTimeoutError(box: Box, timeoutMinutes: number, errorReason: string): Promise<boolean> {
    const lastActivityAt = await this.boxActivityService.getLastActivityAt(box.id)
    if (lastActivityAt && lastActivityAt.getTime() < Date.now() - 1000 * 60 * timeoutMinutes) {
      const updateData: Partial<Box> = {
        state: BoxState.ERROR,
        errorReason,
        recoverable: false,
      }
      await this.boxRepository.update(box.id, { updateData, entity: box })
      return true
    }
    return false
  }

  private async removeBoxFromPreviousRunner(boxId: string, runnerId: string, manager: EntityManager): Promise<void> {
    const runner = await manager.findOneBy(Runner, { id: runnerId })
    if (!runner) {
      this.logger.warn(`Previously assigned runner ${runnerId} for box ${boxId} not found`)
      return
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      await runnerAdapter.destroyBox(boxId, undefined, manager)
    } catch (error) {
      if (error.response?.status !== 404 && error.statusCode !== 404) {
        this.logger.error(`Failed to cleanup box ${boxId} on previous runner ${runner.id}:`, error)
        throw error
      }
    }
  }
}
