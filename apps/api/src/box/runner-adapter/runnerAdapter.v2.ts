/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, IsNull } from 'typeorm'
import { RunnerAdapter, RunnerInfo, RunnerBoxInfo, StartBoxResponse } from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { memoryGiBOf } from '../utils/memory-allocation'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { BoxRepository } from '../repositories/box.repository'
import { RunnerState } from '../enums/runner-state.enum'
import { boxVolumeForDispatch } from '../utils/box-volume.util'

/**
 * RunnerAdapterV2 implements RunnerAdapter for v2 runners.
 * Instead of making direct API calls to the runner, it creates jobs in the database
 * that the v2 runner polls and processes asynchronously.
 */
@Injectable()
export class RunnerAdapterV2 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV2.name)
  private runner: Runner

  @InjectRepository(Runner)
  private readonly runnerRepository: Repository<Runner>

  constructor(
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
    private readonly jobService: JobService,
  ) {}

  async init(runner: Runner): Promise<void> {
    this.runner = runner
  }

  async healthCheck(_signal?: AbortSignal): Promise<void> {
    throw new Error('healthCheck is not supported for V2 runners')
  }

  async runnerInfo(_signal?: AbortSignal): Promise<RunnerInfo> {
    // Admission must observe a revoked report even if the runner lookup was cached.
    const report = await this.runnerRepository.findOne({ where: { id: this.runner.id }, cache: false })
    _signal?.throwIfAborted()
    const age = Date.now() - (report?.lastChecked?.getTime() ?? NaN)
    const fresh = report?.state === RunnerState.READY && age >= 0 && age <= 60_000
    return {
      nestedVirtualizationEnabled: fresh && report.nestedVirtualizationEnabled === true,
    }
  }

  async boxInfo(boxId: string): Promise<RunnerBoxInfo> {
    // Query the box entity
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })

    if (!box) {
      throw new Error(`Box ${boxId} not found`)
    }

    // Query for any incomplete jobs for this box to determine transitional state
    const incompleteJob = await this.jobRepository.findOne({
      where: {
        resourceType: ResourceType.BOX,
        resourceId: boxId,
        completedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    })

    let state = box.state

    let daemonVersion: string | undefined = undefined

    // If there's an incomplete job, infer the transitional state from job type
    if (incompleteJob) {
      state = this.inferStateFromJob(incompleteJob, box)
      daemonVersion = incompleteJob.getResultMetadata()?.daemonVersion
    } else {
      // Look for latest job for this box
      const latestJob = await this.jobRepository.findOne({
        where: {
          resourceType: ResourceType.BOX,
          resourceId: boxId,
        },
        order: { createdAt: 'DESC' },
      })
      if (latestJob) {
        state = this.inferStateFromJob(latestJob, box)
        daemonVersion = latestJob.getResultMetadata()?.daemonVersion
      }
    }

    return {
      state,
      daemonVersion,
    }
  }

  private inferStateFromJob(job: Job, box: Box): BoxState {
    // Map job types to transitional states
    switch (job.type) {
      case JobType.CREATE_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.CREATING
      case JobType.START_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.STARTING
      case JobType.STOP_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STOPPED : BoxState.STOPPING
      case JobType.DESTROY_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.DESTROYED : BoxState.DESTROYING
      default:
        // For other job types (backup, etc.), return current box state
        return box.state
    }
  }

  // A filestore volume needs runner-side NFS mount support. apiVersion 2 alone
  // does not imply it: v2 predates filestore, so an un-upgraded v2 runner
  // drops the filestore reference and mounts a bucket that does not exist.
  // The runner declares the capability in its healthcheck; refusing here —
  // instead of dispatching — keeps the failure at the API with the real
  // cause instead of a misleading bucket error on the runner.
  private async assertFilestoreVolumeSupport(box: Box): Promise<void> {
    if (!box.volumes?.some((volume) => volume.filestore)) return

    // Runner lookup caching is local to an API replica. Read the declaration
    // again so a heartbeat received by another replica cannot leave this one
    // rejecting a capable runner from an hour-old snapshot.
    const runner = await this.runnerRepository.findOne({ where: { id: this.runner.id }, cache: false })
    if (runner?.capabilities?.includes('filestore')) return

    const filestoreVolumes = box.volumes?.filter((volume) => volume.filestore) ?? []
    const lastChecked = runner?.lastChecked
    const lastHealthcheckAgeSeconds = lastChecked
      ? Math.max(0, Math.floor((Date.now() - lastChecked.getTime()) / 1000))
      : undefined
    const diagnostics = [
      `runnerRecordFound=${runner !== null}`,
      `runnerState=${runner?.state ?? 'unknown'}`,
      `apiVersion=${runner?.apiVersion ?? 'unknown'}`,
      `appVersion=${runner?.appVersion ?? 'unknown'}`,
      `capabilities=${JSON.stringify(runner?.capabilities ?? [])}`,
      `volumeIds=${JSON.stringify(filestoreVolumes.map((volume) => volume.volumeId))}`,
      `filestoreInstances=${JSON.stringify(filestoreVolumes.map((volume) => volume.filestore?.instance ?? 'unknown'))}`,
      `lastChecked=${lastChecked?.toISOString() ?? 'never'}`,
      ...(lastHealthcheckAgeSeconds === undefined ? [] : [`lastHealthcheckAgeSeconds=${lastHealthcheckAgeSeconds}`]),
    ].join('; ')
    const error = Object.assign(
      new Error(
        `FILESTORE_CAPABILITY_MISSING: Box ${box.id} requires a runner with the filestore capability, but runner ${this.runner.id} has not declared it (${diagnostics}). No CREATE_BOX job was dispatched. If the healthcheck is recent, inspect why the running binary omitted filestore; otherwise inspect healthcheck delivery to the API.`,
      ),
      { code: 'FILESTORE_CAPABILITY_MISSING' },
    )
    this.logger.error(
      {
        event: 'box.create.dispatch_rejected',
        boxId: box.id,
        runnerId: this.runner.id,
        runnerRecordFound: runner !== null,
        runnerState: runner?.state,
        runnerApiVersion: runner?.apiVersion,
        runnerAppVersion: runner?.appVersion,
        runnerCapabilities: runner?.capabilities ?? [],
        volumeIds: filestoreVolumes.map((volume) => volume.volumeId),
        filestoreInstances: filestoreVolumes.map((volume) => volume.filestore?.instance ?? 'unknown'),
        runnerLastChecked: lastChecked,
        lastHealthcheckAgeSeconds,
        code: error.code,
        err: error,
      },
      'Filestore Box dispatch rejected',
    )
    throw error
  }

  async createBox(
    box: Box,
    image: string,
    metadata?: { [key: string]: string },
    nestedVirtualization = false,
  ): Promise<StartBoxResponse | undefined> {
    if (!image) {
      throw new Error(`Box ${box.id} has no image; cannot create on runner`)
    }

    if (box.privileged && !this.runner.supportsPrivileged) {
      throw new Error(`Runner ${this.runner.id} does not support privileged Boxes`)
    }

    await this.assertFilestoreVolumeSupport(box)
    const payload = {
      id: box.id,
      ...(nestedVirtualization ? { nestedVirtualization: true } : {}),
      image,
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: memoryGiBOf(box),
      storageQuota: box.disk,
      env: box.env,
      runAsUser: box.runAsUser,
      privileged: box.privileged,
      workingDir: box.workingDir,
      entrypoint: box.entrypoint,
      cmd: box.cmd,
      volumes: box.volumes?.map(boxVolumeForDispatch),
      secrets: box.secrets?.map((secret) => ({
        name: secret.name,
        value: secret.value,
        hosts: secret.hosts,
        placeholder: secret.placeholder,
        headers: secret.headers,
      })),
      outboundEnabled: box.outboundEnabled,
      outboundAllowNet: box.outboundAllowNet ?? undefined,
      metadata,
      authToken: box.authToken,
      organizationId: box.organizationId,
      regionId: box.region,
    }

    await this.jobService.createJob(null, JobType.CREATE_BOX, this.runner.id, ResourceType.BOX, box.id, payload)

    this.logger.debug(`Created CREATE_BOX job for box ${box.id} on runner ${this.runner.id}`)

    //  Daemon version is set in the job result metadata once the runner completes the job.
    return undefined
  }

  async startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartBoxResponse | undefined> {
    await this.jobService.createJob(null, JobType.START_BOX, this.runner.id, ResourceType.BOX, boxId, {
      authToken,
      metadata,
    })

    this.logger.debug(`Created START_BOX job for box ${boxId} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async stopBox(boxId: string, force?: boolean): Promise<void> {
    await this.jobService.createJob(null, JobType.STOP_BOX, this.runner.id, ResourceType.BOX, boxId, {
      force,
    })

    this.logger.debug(`Created STOP_BOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async destroyBox(boxId: string): Promise<void> {
    await this.jobService.createJob(null, JobType.DESTROY_BOX, this.runner.id, ResourceType.BOX, boxId)

    this.logger.debug(`Created DESTROY_BOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async recoverBox(): Promise<void> {
    throw new Error('Recovering boxes with runner API version 2 is not supported')
  }

  async updateNetworkSettings(
    _boxId: string,
    _outboundEnabled?: boolean,
    _outboundAllowNet?: string[],
    _networkLimitEgress?: boolean,
  ): Promise<void> {
    throw new Error('Live network settings updates with runner API version 2 are not supported')
  }
}
