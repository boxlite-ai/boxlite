/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { BoxRepository } from '../../repositories/box.repository'
import { Box } from '../../entities/box.entity'
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
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode): Promise<SyncState> {
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

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    await runnerAdapter.createBox(box, metadata)

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

    const metadata: { [key: string]: string } = { ...organization?.boxMetadata }
    if (box.volumes?.length) {
      metadata['volumes'] = JSON.stringify(
        box.volumes.map((v) => ({ volumeId: v.volumeId, mountPath: v.mountPath, subpath: v.subpath })),
      )
    }

    await runnerAdapter.startBox(box.id, box.authToken, metadata)

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
    const boxInfo = await runnerAdapter.boxInfo(box.id)

    switch (boxInfo.state) {
      case BoxState.STARTED: {
        await this.updateBoxState(box, BoxState.STARTED, lockCode, undefined, undefined, boxInfo.daemonVersion)

        //  if box was transferred to a new runner, remove it from the old runner
        if (box.prevRunnerId) {
          await this.removeBoxFromPreviousRunner(box)
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

  private async removeBoxFromPreviousRunner(box: Box): Promise<void> {
    const runner = await this.runnerService.findOne(box.prevRunnerId)
    if (!runner) {
      this.logger.warn(`Previously assigned runner ${box.prevRunnerId} for box ${box.id} not found`)

      await this.boxRepository.update(box.id, { updateData: { prevRunnerId: null } }, true)
      return
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      // First try to destroy the box
      await runnerAdapter.destroyBox(box.id)
    } catch (error) {
      if (error.response?.status !== 404 && error.statusCode !== 404) {
        this.logger.error(`Failed to cleanup box ${box.id} on previous runner ${runner.id}:`, error)
        throw error
      }
    }

    await this.boxRepository.update(box.id, { updateData: { prevRunnerId: null } }, true)
  }
}
