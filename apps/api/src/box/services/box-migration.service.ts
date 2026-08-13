/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { Not, Repository } from 'typeorm'

import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'

// One name for the loop: the cron entry, the execution log line, and the Redis
// key that keeps two workers off the same tick.
const MARKER_LOOP = 'migration-marker'

// One tick's worth of headroom: long enough that a slow tick keeps its lock to
// the end, short enough that a worker lost mid-tick does not park the loop for
// more than the tick after it.
const MARKER_LOOP_LOCK_TTL_SECONDS = 120

/**
 * Drives boxes off draining runners.
 *
 * This is the entry point of a migration and the only one that decides a box
 * should move; every later step reacts to the state this leaves behind. The
 * marking is a single conditional UPDATE rather than a read-then-write, so
 * concurrent starts and stops either land before it and disqualify the box, or
 * land after it and break the timestamp equality a later validity check reads.
 */
@Injectable()
export class BoxMigrationService {
  private readonly logger = new Logger(BoxMigrationService.name)

  constructor(
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    private readonly boxRepository: BoxRepository,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: MARKER_LOOP })
  @LogExecution(MARKER_LOOP)
  @WithInstrumentation()
  private async markBoxesOnDrainingRunners(): Promise<void> {
    // Two workers marking at once would be harmless — the UPDATE is idempotent
    // and the second matches nothing — but it costs a full scan per worker.
    if (!(await this.redisLockProvider.lock(MARKER_LOOP, MARKER_LOOP_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const runnerIds = await this.findDrainingRunnerIds()
      if (runnerIds.length === 0) {
        return
      }

      const marked = await this.boxRepository.markParkedBoxesForExport(runnerIds)
      if (marked > 0) {
        this.logger.log(`Marked ${marked} parked boxes on ${runnerIds.length} draining runners for migration`)
      }
    } catch (error) {
      // Nothing here is half-done: the marking is one statement, so it either
      // committed or it did not, and the next tick re-selects whatever is left.
      this.logger.error('Error marking boxes on draining runners for migration', error)
    } finally {
      await this.redisLockProvider.unlock(MARKER_LOOP)
    }
  }

  /**
   * Runners being emptied, excluding the ones already gone — a decommissioned
   * runner cannot export the box it no longer serves.
   */
  private async findDrainingRunnerIds(): Promise<string[]> {
    const runners = await this.runnerRepository.find({
      where: {
        draining: true,
        state: Not(RunnerState.DECOMMISSIONED),
      },
      select: ['id'],
    })

    return runners.map((runner) => runner.id)
  }
}
