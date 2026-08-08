/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, In } from 'typeorm'
import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { S3Client, CreateBucketCommand, ListObjectsV2Command, PutBucketTaggingCommand } from '@aws-sdk/client-s3'
import { RedisLockProvider, withRedisLockLease } from '../common/redis-lock.provider'
import { TypedConfigService } from '../../config/typed-config.service'
import { deleteS3Bucket } from '../../common/utils/delete-s3-bucket'

import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { setTimeout } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'

const VOLUME_STATE_LOCK_KEY = 'volume-state-'

@Injectable()
export class VolumeManager
  implements OnModuleInit, TrackableJobExecutions, OnApplicationShutdown, OnApplicationBootstrap
{
  activeJobs = new Set<symbol>()

  private readonly logger = new Logger(VolumeManager.name)
  private processingVolumes: Set<string> = new Set()
  private skipTestConnection = false
  private s3Client: S3Client | null = null

  constructor(
    @InjectRepository(Volume)
    private readonly volumeRepository: Repository<Volume>,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    if (!this.configService.get('s3.endpoint')) {
      return
    }

    const endpoint = this.configService.getOrThrow('s3.endpoint')
    const region = this.configService.getOrThrow('s3.region')
    const accessKeyId = this.configService.get('s3.accessKey')
    const secretAccessKey = this.configService.get('s3.secretKey')
    this.skipTestConnection = this.configService.get('skipConnections')

    // Both-or-neither: a lone key is a typo'd pair, and silently falling back
    // to the SDK default chain would mask the misconfig.
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be set together')
    }
    // MinIO cannot use the SDK default chain — fail fast at boot with a clear
    // message instead of a generic auth error from the connection probe.
    if (endpoint.includes('minio') && !accessKeyId) {
      throw new Error('MinIO requires S3_ACCESS_KEY and S3_SECRET_KEY to be configured')
    }

    this.s3Client = new S3Client({
      endpoint: endpoint.startsWith('http') ? endpoint : `http://${endpoint}`,
      region,
      // Static keys for S3-compatible deployments (MinIO); unset on AWS,
      // where the SDK default chain supplies the ECS task-role credentials.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      forcePathStyle: true,
    })
  }

  async onModuleInit() {
    if (!this.s3Client) {
      return
    }

    if (this.skipTestConnection) {
      this.logger.debug('Skipping S3 connection test')
      return
    }

    await this.testConnection()
  }

  onApplicationBootstrap() {
    if (!this.s3Client) {
      return
    }

    this.schedulerRegistry.getCronJob('process-pending-volumes').start()
  }

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await setTimeout(1000)
    }
  }

  private async testConnection() {
    // Probe a bucket we already know instead of ListBuckets: same
    // connectivity+auth signal, but needs no account-wide
    // s3:ListAllMyBuckets grant on the task role.
    const bucket = this.configService.get('s3.defaultBucket')
    if (!bucket) {
      this.logger.debug('No default bucket configured; skipping S3 connection test')
      return
    }

    try {
      const command = new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })
      await this.s3Client.send(command)
      this.logger.debug('Successfully connected to S3')
    } catch (error) {
      this.logger.error('Failed to connect to S3:', error)
      throw error
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'process-pending-volumes', waitForCompletion: true, disabled: true })
  @TrackJobExecution()
  @LogExecution('process-pending-volumes')
  @WithInstrumentation()
  async processPendingVolumes() {
    if (!this.s3Client) {
      return
    }

    const lockKey = 'process-pending-volumes'
    try {
      // Lock the entire process
      const lease = await this.redisLockProvider.acquireLease(lockKey, 30)
      if (!lease) {
        return
      }

      await withRedisLockLease(lease, async (signal) => {
        const pendingVolumes = await this.volumeRepository.find({
          where: {
            state: In([VolumeState.PENDING_CREATE, VolumeState.PENDING_DELETE]),
          },
        })

        const results = await Promise.allSettled(
          pendingVolumes.map(async (volume) => {
            signal.throwIfAborted()
            if (this.processingVolumes.has(volume.id)) {
              return
            }

            // Get lock for this specific volume
            const volumeLockKey = `${VOLUME_STATE_LOCK_KEY}${volume.id}`
            const volumeLease = await this.redisLockProvider.acquireLease(volumeLockKey, 30)
            if (!volumeLease) {
              return
            }

            await withRedisLockLease(volumeLease, async (volumeSignal) => {
              signal.throwIfAborted()
              this.processingVolumes.add(volume.id)
              try {
                await this.processVolumeState(volume, volumeSignal)
              } finally {
                this.processingVolumes.delete(volume.id)
              }
            })
          }),
        )
        signal.throwIfAborted()
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (rejected) {
          throw rejected.reason
        }
      })
    } catch (error) {
      this.logger.error('Error processing pending volumes:', error)
    }
  }

  private async processVolumeState(volume: Volume, signal: AbortSignal): Promise<void> {
    try {
      switch (volume.state) {
        case VolumeState.PENDING_CREATE:
          await this.handlePendingCreate(volume, signal)
          break
        case VolumeState.PENDING_DELETE:
          await this.handlePendingDelete(volume, signal)
          break
      }
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      this.logger.error(`Error processing volume ${volume.id}:`, error)
      await this.volumeRepository.update(volume.id, {
        state: VolumeState.ERROR,
        errorReason: error.message,
      })
    }
  }

  private async handlePendingCreate(volume: Volume, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted()
      // Create bucket in Minio/S3
      const createBucketCommand = new CreateBucketCommand({
        Bucket: volume.getBucketName(),
      })

      try {
        await this.s3Client.send(createBucketCommand)
      } catch (error) {
        if (error.name !== 'BucketAlreadyOwnedByYou') {
          throw error
        }
      }
      signal.throwIfAborted()

      await this.s3Client.send(
        new PutBucketTaggingCommand({
          Bucket: volume.getBucketName(),
          Tagging: {
            TagSet: [
              {
                Key: 'VolumeId',
                Value: volume.id,
              },
              {
                Key: 'OrganizationId',
                Value: volume.organizationId,
              },
              {
                Key: 'Environment',
                Value: this.configService.get('environment'),
              },
            ],
          },
        }),
      )

      // Update volume state to READY
      signal.throwIfAborted()
      await this.volumeRepository.save({
        ...volume,
        state: VolumeState.READY,
      })
      this.logger.debug(`Volume ${volume.id} created successfully`)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      this.logger.error(`Error creating volume ${volume.id}:`, error)
      await this.volumeRepository.save({
        ...volume,
        state: VolumeState.ERROR,
        errorReason: error.message,
      })
    }
  }

  private async handlePendingDelete(volume: Volume, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted()
      // Delete bucket from Minio/S3
      try {
        await deleteS3Bucket(this.s3Client, volume.getBucketName())
        signal.throwIfAborted()
      } catch (error) {
        if (error.name === 'NoSuchBucket') {
          this.logger.warn(`Bucket for volume ${volume.id} does not exist, treating as already deleted`)
        } else if (error.name === 'BucketNotEmpty') {
          throw new Error('Volume deletion failed because the bucket is not empty. You may retry deletion.')
        } else {
          throw error
        }
      }

      // Delete any existing volume record with the deleted state and the same name in the same organization
      signal.throwIfAborted()
      await this.volumeRepository.delete({
        organizationId: volume.organizationId,
        name: `${volume.name}-deleted`,
        state: VolumeState.DELETED,
      })

      // Update volume state to DELETED and rename
      signal.throwIfAborted()
      await this.volumeRepository.save({
        ...volume,
        state: VolumeState.DELETED,
        name: `${volume.name}-deleted`,
      })
      this.logger.debug(`Volume ${volume.id} deleted successfully`)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      this.logger.error(`Error deleting volume ${volume.id}:`, error)
      await this.volumeRepository.save({
        ...volume,
        state: VolumeState.ERROR,
        errorReason: error.message,
      })
    }
  }
}
