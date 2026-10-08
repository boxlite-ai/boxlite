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
import {
  warmPoolBoxWhere,
  warmPoolRowWhere,
  warmPoolSpecOfBox,
  warmPoolSpecOfRow,
  WarmPoolSpec,
} from '../utils/warm-pool-spec.util'
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
      where: { ...warmPoolRowWhere(params), pool: MoreThan(0) },
    })
    if (warmPoolItem) {
      const availabilityScoreThreshold = this.configService.getOrThrow<number>('runnerScore.thresholds.availability')

      // Build subquery to find excluded runners (unschedulable OR low score)
      const excludedRunnersSubquery = this.runnerRepository
        .createQueryBuilder('runner')
        .select('runner.id')
        .where('runner.region = :region')
        .andWhere('(runner.unschedulable = true OR runner.availabilityScore < :scoreThreshold)')

      const spec = warmPoolSpecOfRow(warmPoolItem)
      const queryBuilder = this.boxRepository
        .createQueryBuilder('box')
        .where('box.organizationId = :organizationId', {
          organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        })
        .andWhere('box.state = :state', { state: BoxState.STARTED })
        .andWhere(`box.runnerId NOT IN (${excludedRunnersSubquery.getQuery()})`)
        // The subquery reads `:region` too, and it names that parameter rather
        // than building it from the tuple. The loop below binds it as well —
        // to the same value, since both come from `spec` — but binding it here
        // is what keeps renaming a tuple field from breaking the exclusion at
        // runtime and nowhere else. Neither binding is redundant on its own.
        .setParameters({ region: spec.target, scoreThreshold: availabilityScoreThreshold })
      // The tuple, one column per entry, from the same place the pool row was
      // found with. A query builder is needed here for the runner-exclusion
      // subquery, which a find-options where cannot express.
      for (const [column, value] of Object.entries(warmPoolBoxWhere(spec))) {
        queryBuilder.andWhere(`box.${column} = :${column}`, { [column]: value })
      }

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

  /**
   * How many boxes a pool row currently has. Errored boxes do not count — the
   * pool is short by one until they are cleaned up, which is what makes the
   * top-up fire again.
   */
  private countPoolBoxes(spec: WarmPoolSpec): Promise<number> {
    return this.boxRepository.count({
      where: {
        ...warmPoolBoxWhere(spec),
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        desiredState: BoxDesiredState.STARTED,
        state: Not(In([BoxState.ERROR])),
      },
    })
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

        const boxCount = await this.countPoolBoxes(warmPoolSpecOfRow(warmPoolItem))

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
    const warmPoolItem = await this.warmPoolRepository.findOne({
      where: warmPoolRowWhere(warmPoolSpecOfBox(event.box)),
    })

    if (!warmPoolItem) {
      return
    }

    const boxCount = await this.countPoolBoxes(warmPoolSpecOfRow(warmPoolItem))

    if (warmPoolItem.pool <= boxCount) {
      return
    }

    if (warmPoolItem) {
      this.eventEmitter.emit(WarmPoolEvents.TOPUP_REQUESTED, new WarmPoolTopUpRequested(warmPoolItem))
    }
  }
}
