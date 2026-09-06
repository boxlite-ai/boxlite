/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, In } from 'typeorm'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TypedConfigService } from '../../config/typed-config.service'

const REDIS_ACTIVITY_KEY = 'box:activity'

interface BoxActivityUpdate {
  boxId: string
  lastActivityAt: Date
}

@Injectable()
export class BoxActivityService {
  private readonly logger = new Logger(BoxActivityService.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Buffers a last activity timestamp in Redis (throttled to once per configured throttle TTL).
   *
   * Relies on the periodic flush to the database.
   */
  async updateLastActivityAt(boxId: string, lastActivityAt: Date): Promise<void> {
    const lockKey = `box:update-last-activity:${boxId}`
    const acquired = await this.redisLockProvider.lock(
      lockKey,
      this.configService.getOrThrow('boxActivity.throttleTtlSeconds'),
    )
    if (!acquired) {
      return
    }
    await this.redis.zadd(REDIS_ACTIVITY_KEY, lastActivityAt.getTime(), boxId)
  }

  /**
   * Read the last activity timestamp for a box.
   *
   * Checks Redis buffer first, falls back to the database.
   */
  async getLastActivityAt(boxId: string): Promise<Date | null> {
    const timestamps = await this.getLastActivityAtMany([boxId])
    return timestamps.get(boxId) ?? null
  }

  /**
   * Read the last activity timestamps for many boxes.
   *
   * Same buffer-before-database precedence as {@link getLastActivityAt}, in two
   * round trips regardless of how many boxes are asked for: one pipelined Redis
   * read, then a single query for the boxes the buffer did not answer. Boxes
   * with no recorded activity are absent from the map.
   */
  async getLastActivityAtMany(boxIds: string[]): Promise<Map<string, Date>> {
    const timestamps = new Map<string, Date>()
    const uniqueBoxIds = [...new Set(boxIds)]
    if (uniqueBoxIds.length === 0) {
      return timestamps
    }

    const pipeline = this.redis.pipeline()
    for (const boxId of uniqueBoxIds) {
      pipeline.zscore(REDIS_ACTIVITY_KEY, boxId)
    }
    // ZMSCORE would be one command, but it needs Redis 6.2; a pipeline reads
    // the same buffer in one round trip against any server version.
    const bufferedScores = await pipeline.exec()

    const unbufferedBoxIds: string[] = []
    uniqueBoxIds.forEach((boxId, index) => {
      const [error, score] = bufferedScores?.[index] ?? [null, null]
      // A per-command failure is raised rather than answered from the database:
      // a single-box ZSCORE failure has always surfaced to the caller.
      if (error) {
        throw error
      }
      if (score === null || score === undefined) {
        unbufferedBoxIds.push(boxId)
        return
      }
      timestamps.set(boxId, new Date(Number(score)))
    })

    if (unbufferedBoxIds.length === 0) {
      return timestamps
    }

    const rows = await this.dataSource.getRepository(BoxLastActivity).findBy({ boxId: In(unbufferedBoxIds) })
    for (const row of rows) {
      if (row.lastActivityAt) {
        timestamps.set(row.boxId, row.lastActivityAt)
      }
    }

    return timestamps
  }

  /**
   * Flush buffered activity timestamps from Redis to the database in bulk.
   * Processes entries in batches to avoid oversized transactions.
   *
   * Frequency must be < 1min to prevent unintended auto-lifecycle actions.
   */
  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'flush-activity-to-db' })
  @LogExecution('flush-activity-to-db')
  @WithInstrumentation()
  async flushActivityToDb(): Promise<void> {
    const lockKey = 'flush-activity-to-db-lock'
    const lockTtl = 30
    const acquired = await this.redisLockProvider.lock(lockKey, lockTtl)
    if (!acquired) {
      return
    }

    try {
      let totalFlushed = 0

      const batchSize = this.configService.getOrThrow('boxActivity.flushBatchSize')
      const maxScore = Date.now()

      const entries = await this.redis.zrangebyscore(REDIS_ACTIVITY_KEY, '-inf', maxScore, 'WITHSCORES')

      if (entries.length === 0) {
        return
      }

      const updates: BoxActivityUpdate[] = []
      for (let i = 0; i < entries.length; i += 2) {
        updates.push({
          boxId: entries[i],
          lastActivityAt: new Date(Number(entries[i + 1])),
        })
      }

      for (let offset = 0; offset < updates.length; offset += batchSize) {
        const batch = updates.slice(offset, offset + batchSize)
        await this.bulkUpsertActivity(batch)
        totalFlushed += batch.length
      }

      await this.redis.zremrangebyscore(REDIS_ACTIVITY_KEY, '-inf', maxScore)

      if (totalFlushed > 0) {
        this.logger.debug(`Flushed ${totalFlushed} activity timestamps to the database`)
      }
    } catch (error) {
      this.logger.error('Error flushing activity timestamps to the database:', error)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  /**
   * Builds a query to upsert activity timestamps into the database.
   *
   * Uses a conditional upsert that only updates when the incoming timestamp is newer, preventing updates to stale buffered values.
   */
  private buildUpsertQuery(values: BoxActivityUpdate | BoxActivityUpdate[]) {
    // ON CONFLICT names the row already there by the table's own name, and the
    // guard is written against that name by hand: an object-form condition is
    // built against the builder's alias for the target instead, which is the
    // entity's table path — under a non-default schema that is quoted whole,
    // as "schema.box_last_activity", a table no clause of the statement has.
    const conflictTarget = this.dataSource.getMetadata(BoxLastActivity).tableName
    const storedAt = `"${conflictTarget}"."lastActivityAt"`

    return this.dataSource
      .createQueryBuilder()
      .insert()
      .into(BoxLastActivity)
      .values(values)
      .orUpdate(['lastActivityAt'], ['boxId'], {
        overwriteCondition: {
          where: `(${storedAt} IS NULL OR ${storedAt} < EXCLUDED."lastActivityAt")`,
        },
      })
  }

  /**
   * Bulk upserts activity timestamps into the database.
   *
   * In case of FK violations, falls back to individual upserts to skip deleted box(es).
   */
  private async bulkUpsertActivity(updates: BoxActivityUpdate[]): Promise<void> {
    if (updates.length === 0) {
      this.logger.debug('No activity updates to flush')
      return
    }

    try {
      await this.buildUpsertQuery(updates).execute()
    } catch (bulkUpsertError) {
      if (bulkUpsertError.code === '23503') {
        this.logger.warn(
          'Bulk upsert for activity timestamps failed with FK violation, falling back to individual upserts',
        )
        for (const update of updates) {
          try {
            await this.buildUpsertQuery(update).execute()
          } catch (error) {
            if (error.code === '23503') {
              this.logger.warn(`Skipping activity flush for box ${update.boxId} (deleted)`)
            } else {
              throw error
            }
          }
        }
      } else {
        throw bulkUpsertError
      }
    }
  }
}
