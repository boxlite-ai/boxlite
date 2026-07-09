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
import { ScheduleConfig, WarmPool } from '../entities/warm-pool.entity'
import { resolveWarmPoolTarget } from './warm-pool-schedule'
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
  image: string
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
    //  check if box is warm pool
    const warmPoolItem = await this.warmPoolRepository.findOne({
      where: {
        image: params.image,
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
        .where('box.image = :image', { image: warmPoolItem.image })
        .andWhere('box.class = :class', { class: warmPoolItem.class })
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

    //  no warm pool config exists for this image — cache it so callers can skip
    await this.redis.set(`warm-pool:skip:${params.image}`, '1', 'EX', 60)

    return null
  }

  async listWarmPools(): Promise<WarmPool[]> {
    return this.warmPoolRepository.find()
  }

  async findWarmPool(id: string): Promise<WarmPool | null> {
    return this.warmPoolRepository.findOne({ where: { id } })
  }

  async updateSchedule(
    id: string,
    scheduleConfig: ScheduleConfig | null | undefined,
    timezone: string | undefined,
  ): Promise<WarmPool> {
    // Both fields are independently optional: omitting one leaves it unchanged,
    // so a caller can retune the schedule without restating the timezone.
    const patch: Partial<WarmPool> = {}
    if (scheduleConfig !== undefined) {
      patch.scheduleConfig = scheduleConfig
    }
    if (timezone !== undefined) {
      patch.timezone = timezone
    }
    if (Object.keys(patch).length > 0) {
      await this.warmPoolRepository.update(id, patch)
    }
    return this.warmPoolRepository.findOneOrFail({ where: { id } })
  }

  private computeTargetPoolSize(item: WarmPool): number {
    return resolveWarmPoolTarget(item.scheduleConfig, item.timezone, item.pool, new Date())
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

        try {
          const boxCount = await this.boxRepository.count({
            where: {
              organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
              image: warmPoolItem.image,
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

          const target = this.computeTargetPoolSize(warmPoolItem)
          const missingCount = target - boxCount
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

          const excessCount = boxCount - target
          if (excessCount > 0) {
            const candidates = await this.boxRepository.find({
              where: {
                organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
                image: warmPoolItem.image,
                class: warmPoolItem.class,
                cpu: warmPoolItem.cpu,
                mem: warmPoolItem.mem,
                disk: warmPoolItem.disk,
                gpu: warmPoolItem.gpu,
                osUser: warmPoolItem.osUser,
                env: warmPoolItem.env,
                region: warmPoolItem.target,
                state: BoxState.STARTED,
                desiredState: BoxDesiredState.STARTED,
              },
              take: excessCount,
            })

            this.logger.debug(`Scaling down ${candidates.length} excess boxes for warm pool id ${warmPoolItem.id}`)

            for (const box of candidates) {
              // Distinct name from the outer warm-pool tick lock (`lockKey`) to
              // avoid shadowing. Held for its full 30s TTL (not released here):
              // that window blocks a concurrent user claim from grabbing a box
              // we've just marked for destruction. Same key `fetchWarmPoolBox`
              // uses, so claim and scale-down are mutually exclusive.
              const boxLockKey = `box-warm-pool-${box.id}`
              if (!(await this.redisLockProvider.lock(boxLockKey, 30))) {
                continue // being claimed right now, skip
              }
              await this.boxRepository.update(box.id, {
                updateData: { desiredState: BoxDesiredState.DESTROYED, pending: true },
              })
            }
          }
        } finally {
          await this.redisLockProvider.unlock(lockKey)
        }
      }),
    )
  }

  @OnEvent(BoxEvents.ORGANIZATION_UPDATED)
  async handleBoxOrganizationUpdated(event: BoxOrganizationUpdatedEvent) {
    if (event.newOrganizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      return
    }
    const warmPoolItem = await this.warmPoolRepository.findOne({
      where: {
        image: event.box.image,
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
        image: warmPoolItem.image,
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

    // Use the schedule-aware target, matching warmPoolCheck(). Comparing against
    // the static pool here would fight the cron: when a schedule window sets a
    // higher/lower target, the claim fast-path would top up to the wrong size and
    // churn against scale-up/scale-down on the next tick.
    const target = this.computeTargetPoolSize(warmPoolItem)
    if (target <= boxCount) {
      return
    }

    this.eventEmitter.emit(WarmPoolEvents.TOPUP_REQUESTED, new WarmPoolTopUpRequested(warmPoolItem))
  }
}
