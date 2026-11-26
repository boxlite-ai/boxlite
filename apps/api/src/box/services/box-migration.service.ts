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
 * marker locks each parked Box, checks ownership and copies its stamp into the
 * migration row in the same transaction. The receiver checks eligibility again
 * before applying a completed export or import.
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
    // The database lock and insert guard handle concurrent markers. Keep one
    // worker per tick to avoid scanning the fleet twice.
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
