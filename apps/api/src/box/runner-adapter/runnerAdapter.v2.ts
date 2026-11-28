/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'
import { SecretCredentialService } from '../services/secret-credential.service'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, IsNull, EntityManager } from 'typeorm'
import { RunnerAdapter, RunnerInfo, RunnerBoxInfo, StartBoxResponse } from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { memoryGiBOf } from '../utils/memory-allocation'
import { Job } from '../entities/job.entity'
import { JobDto } from '../dto/job.dto'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { BoxRepository } from '../repositories/box.repository'
import { RunnerState } from '../enums/runner-state.enum'
import { boxVolumeForDispatch } from '../utils/box-volume.util'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'

/**
 * RunnerAdapterV2 implements RunnerAdapter for v2 runners.
 * Jobs ordinarily use the v2 long-poll path. Capable, ready Runners can accept
 * fresh CREATE_BOX jobs directly; every job completes through the same callback.
 */
@Injectable()
export class RunnerAdapterV2 implements RunnerAdapter {
  @Inject(TypedConfigService)
  private readonly config: TypedConfigService

  @Inject(SecretCredentialService)
  private readonly credentials: SecretCredentialService
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

    // An incomplete job takes precedence over a previous terminal result.
    const where = { resourceType: ResourceType.BOX, resourceId: boxId }
    const order = { createdAt: 'DESC' } as const
    const incompleteJob = await this.jobRepository.findOne({
      where: { ...where, completedAt: IsNull() },
      order,
    })
    const job = incompleteJob ?? (await this.jobRepository.findOne({ where, order }))
    const failedDestroy = !incompleteJob && job?.type === JobType.DESTROY_BOX && job.status === JobStatus.FAILED
    return {
      state: job ? this.inferStateFromJob(job, box) : box.state,
      daemonVersion: job?.getResultMetadata()?.daemonVersion,
      ...(failedDestroy && { failedDestroyJob: true }),
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
  async assertFilestoreVolumeSupport(box: Box): Promise<void> {
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
        `FILESTORE_CAPABILITY_MISSING: Box ${box.id} requires a runner with the filestore capability, but runner ${this.runner.id} has not declared it (${diagnostics}). No Box job was dispatched. If the healthcheck is recent, inspect why the running binary omitted filestore; otherwise inspect healthcheck delivery to the API.`,
      ),
      { code: 'FILESTORE_CAPABILITY_MISSING' },
    )
    this.logger.error(
      {
        event: 'box.dispatch_rejected',
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

  private supportsDirectCreate(): boolean {
    return Boolean(
      this.config.get('runnerDirectCreate.enabled') &&
        this.runner.state === RunnerState.READY &&
        this.runner.apiUrl &&
        this.runner.capabilities?.includes('direct-create-v1'),
    )
  }

  private createCreateBoxJob(
    manager: EntityManager | null,
    box: Box,
    payload: Record<string, any>,
    direct: boolean,
  ): Promise<Job> {
    if (direct) {
      return this.jobService.createJob(manager, JobType.CREATE_BOX, this.runner.id, ResourceType.BOX, box.id, payload, {
        direct: true,
      })
    }
    return this.jobService.createJob(manager, JobType.CREATE_BOX, this.runner.id, ResourceType.BOX, box.id, payload)
  }

  private async dispatchDirectCreate(job: Job): Promise<void> {
    try {
      const response = await axios.post(
        `${this.runner.apiUrl!.replace(/\/+$/, '')}/internal/jobs/${encodeURIComponent(job.id)}/direct-create`,
        new JobDto(job),
        {
          headers: { Authorization: `Bearer ${this.runner.apiKey}` },
          timeout: 10_000,
        },
      )
      if (response.status !== 202) {
        throw new Error(`Runner returned HTTP ${response.status}`)
      }
    } catch (error) {
      throw new Error(`Direct CREATE_BOX dispatch failed for job ${job.id} on runner ${this.runner.id}`, {
        cause: error,
      })
    }
  }

  @WithInstrumentation('box.runner_create_dispatch')
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
    const enabled = this.config.get('secretServer.enabled')
    const secrets = box.secrets ?? []
    if (!enabled && secrets.some((secret) => secret.secretId !== undefined)) {
      throw new Error('Secret references require Secret Server to be enabled')
    }
    if (enabled && secrets.some((secret) => !secret.secretId)) {
      throw new Error('Secret Server requires secret references; migrate inline secrets before enabling')
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
        ...(!enabled ? { value: secret.value } : {}),
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

    const direct = this.supportsDirectCreate()
    if (enabled && secrets.length) {
      const job = await this.jobRepository.manager.transaction(async (manager) => {
        const secretCredential = await this.credentials.issue(
          {
            runnerId: this.runner.id,
            boxId: box.id,
            organizationId: box.organizationId,
            secretIds: secrets.map((secret) => secret.secretId),
          },
          manager,
        )
        return this.createCreateBoxJob(manager, box, { ...payload, secretCredential }, direct)
      })
      if (direct) {
        await this.dispatchDirectCreate(job)
      } else {
        await this.jobService.notifyRunner(job.runnerId, job.id)
      }
    } else {
      const job = await this.createCreateBoxJob(null, box, payload, direct)
      if (direct) await this.dispatchDirectCreate(job)
    }

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
