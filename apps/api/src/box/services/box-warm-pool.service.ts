/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron, CronExpression } from '@nestjs/schedule'
import { In, MoreThan, Not, Repository } from 'typeorm'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxRepository } from '../repositories/box.repository'
import { Box } from '../entities/box.entity'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { WarmPool } from '../entities/warm-pool.entity'
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxOrganizationUpdatedEvent } from '../events/box-organization-updated.event'
import { ConfigService } from '@nestjs/config'
import { BoxClass } from '../enums/box-class.enum'
import { BoxState } from '../enums/box-state.enum'
import { Runner } from '../entities/runner.entity'
import { WarmPoolTopUpRequested } from '../events/warmpool-topup-requested.event'
import { WarmPoolEvents } from '../constants/warmpool-events.constants'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'

export type FetchWarmPoolBoxParams = {
  template: string
  target: string
  class: BoxClass
  cpu: number
  mem: number
  disk: number
  gpu: number
  osUser: string
  env: { [key: string]: string }
  organizationId: string
  state: string
}

@Injectable()
export class BoxWarmPoolService {
  private readonly logger = new Logger(BoxWarmPoolService.name)

  constructor(
    @InjectRepository(WarmPool)
    private readonly warmPoolRepository: Repository<WarmPool>,
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: ConfigService,
    @Inject(EventEmitter2)
    private eventEmitter: EventEmitter2,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  //  on init
  async onApplicationBootstrap() {
    //  await this.adHocBackupCheck()
  }

  async fetchWarmPoolBox(params: FetchWarmPoolBoxParams): Promise<Box | null> {
    // TODO(image-rewrite): box_template validation removed; the warm pool now matches on the
    // raw template name string carried by the warm_pool config. Rebuild template resolution here.
    const templateName = params.template || this.configService.get<string>('defaultTemplate')

    //  check if box is warm pool
    const warmPoolItem = await this.warmPoolRepository.findOne({
      where: {
        template: templateName,
        target: params.target,
        class: params.class,
        cpu: params.cpu,
        mem: params.mem,
        disk: params.disk,
        gpu: params.gpu,
        osUser: params.osUser,
        env: params.env,
        pool: MoreThan(0),
      },
    })
    if (warmPoolItem) {
      const availabilityScoreThreshold = this.configService.getOrThrow<number>('runnerScore.thresholds.availability')

      // Build subquery to find excluded runners (unschedulable OR low score)
      const excludedRunnersSubquery = this.runnerRepository
        .createQueryBuilder('runner')
        .select('runner.id')
        .where('runner.region = :region')
        .andWhere('(runner.unschedulable = true OR runner.availabilityScore < :scoreThreshold)')

      const queryBuilder = this.boxRepository
        .createQueryBuilder('box')
        .where('box.class = :class', { class: warmPoolItem.class })
        .andWhere('box.cpu = :cpu', { cpu: warmPoolItem.cpu })
        .andWhere('box.mem = :mem', { mem: warmPoolItem.mem })
        .andWhere('box.disk = :disk', { disk: warmPoolItem.disk })
        .andWhere('box.osUser = :osUser', { osUser: warmPoolItem.osUser })
        .andWhere('box.env = :env', { env: warmPoolItem.env })
        .andWhere('box.organizationId = :organizationId', {
          organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        })
        .andWhere('box.region = :region', { region: warmPoolItem.target })
        .andWhere('box.state = :state', { state: BoxState.STARTED })
        .andWhere(`box.runnerId NOT IN (${excludedRunnersSubquery.getQuery()})`)
        .setParameters({
          region: warmPoolItem.target,
          scoreThreshold: availabilityScoreThreshold,
        })

      const candidateLimit = this.configService.getOrThrow<number>('warmPool.candidateLimit')
      const warmPoolBoxes = await queryBuilder.orderBy('RANDOM()').take(candidateLimit).getMany()

      //  make sure we only release warm pool box once
      let warmPoolBox: Box | null = null
      for (const box of warmPoolBoxes) {
        const lockKey = `box-warm-pool-${box.id}`
        if (!(await this.redisLockProvider.lock(lockKey, 10))) {
          continue
        }

        warmPoolBox = box
        break
      }

      return warmPoolBox
    }

    //  no warm pool config exists for this template — cache it so callers can skip
    await this.redis.set(`warm-pool:skip:${templateName}`, '1', 'EX', 60)

    return null
  }

  //  todo: make frequency configurable or more efficient
  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'warm-pool-check' })
  @LogExecution('warm-pool-check')
  @WithInstrumentation()
  async warmPoolCheck(): Promise<void> {
    const warmPoolItems = await this.warmPoolRepository.find()

    await Promise.all(
      warmPoolItems.map(async (warmPoolItem) => {
        const lockKey = `warm-pool-lock-${warmPoolItem.id}`
        if (!(await this.redisLockProvider.lock(lockKey, 720))) {
          return
        }

        // TODO(image-rewrite): Box.template column removed with box_template; warm pool boxes
        // can no longer be matched by template. Rebuild template-aware matching here.
        const boxCount = await this.boxRepository.count({
          where: {
            organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
            class: warmPoolItem.class,
            osUser: warmPoolItem.osUser,
            env: warmPoolItem.env,
            region: warmPoolItem.target,
            cpu: warmPoolItem.cpu,
            gpu: warmPoolItem.gpu,
            mem: warmPoolItem.mem,
            disk: warmPoolItem.disk,
            desiredState: BoxDesiredState.STARTED,
            state: Not(In([BoxState.ERROR])),
          },
        })

        const missingCount = warmPoolItem.pool - boxCount
        if (missingCount > 0) {
          const promises = []
          this.logger.debug(`Creating ${missingCount} boxes for warm pool id ${warmPoolItem.id}`)

          for (let i = 0; i < missingCount; i++) {
            promises.push(
              this.eventEmitter.emitAsync(WarmPoolEvents.TOPUP_REQUESTED, new WarmPoolTopUpRequested(warmPoolItem)),
            )
          }

          // Wait for all promises to settle before releasing the lock. Otherwise, another worker could start creating boxes
          await Promise.allSettled(promises)
        }

        await this.redisLockProvider.unlock(lockKey)
      }),
    )
  }

  @OnEvent(BoxEvents.ORGANIZATION_UPDATED)
  async handleBoxOrganizationUpdated(event: BoxOrganizationUpdatedEvent) {
    if (event.newOrganizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      return
    }
    // TODO(image-rewrite): Box.template column removed with box_template; warm pool matching no
    // longer constrains on template. Rebuild template-aware matching here.
    const warmPoolItem = await this.warmPoolRepository.findOne({
      where: {
        class: event.box.class,
        cpu: event.box.cpu,
        mem: event.box.mem,
        disk: event.box.disk,
        target: event.box.region,
        env: event.box.env,
        gpu: event.box.gpu,
        osUser: event.box.osUser,
      },
    })

    if (!warmPoolItem) {
      return
    }

    const boxCount = await this.boxRepository.count({
      where: {
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        class: warmPoolItem.class,
        osUser: warmPoolItem.osUser,
        env: warmPoolItem.env,
        region: warmPoolItem.target,
        cpu: warmPoolItem.cpu,
        gpu: warmPoolItem.gpu,
        mem: warmPoolItem.mem,
        disk: warmPoolItem.disk,
        desiredState: BoxDesiredState.STARTED,
        state: Not(In([BoxState.ERROR])),
      },
    })

    if (warmPoolItem.pool <= boxCount) {
      return
    }

    if (warmPoolItem) {
      this.eventEmitter.emit(WarmPoolEvents.TOPUP_REQUESTED, new WarmPoolTopUpRequested(warmPoolItem))
    }
  }
}
