/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { TypeOrmHealthIndicator } from '@nestjs/terminus'
import { InjectRepository } from '@nestjs/typeorm'
import axios from 'axios'
import Redis from 'ioredis'
import { In, Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { Runner } from '../../box/entities/runner.entity'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisHealthIndicator } from '../../health/redis.health'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { AlertEvent, IncidentIoClient } from './incident-io.client'

const STATUS_SYNC_LOCK_KEY = 'status-sync'

/**
 * Safety margin the lock keeps over the slowest possible tick (one probe
 * timeout plus one incident.io timeout), so the key cannot expire while a
 * request is still in flight and let a second replica interleave sends.
 */
const LOCK_MARGIN_MS = 30_000

/** Consecutive bad ticks before a public "down" — ~90s of sustained failure. */
const FIRE_AFTER_TICKS = 3
/** Consecutive good ticks before a public recovery — absorbs one-tick blips. */
const RESOLVE_AFTER_TICKS = 2
/** Damping state survives deploys but self-clears when a component vanishes. */
const STATE_TTL_SECONDS = 86_400
const STATE_KEY_PREFIX = 'status-sync:component:'

type AlertStatus = 'firing' | 'resolved'

interface ComponentObservation {
  /** Stable id — the Redis damping key and the tail of the dedup key. */
  id: string
  component: 'api' | 'boxes' | 'box-ingress'
  region?: string
  title: string
  healthy: boolean
  detail: string
}

interface ComponentSendState {
  sent: AlertStatus
  streak: number
}

/**
 * Pushes component health to incident.io so the public status page updates
 * without a human: per-component alert events (firing/resolved, stable dedup
 * keys) on damped state transitions, plus a heartbeat ping after every
 * completed tick so a dead reporter is itself alarmed by incident.io.
 *
 * Observed components: `api` (DB + Redis reachability), `boxes-<region>`
 * (runner fleet per SHARED region), `box-ingress-<region>` (each SHARED
 * region's proxy /health over its public URL). Deliberate v1 blind spots: a
 * region with no eligible runners emits nothing; draining runners are the
 * operator's intent and excluded; per-runner serviceHealth granularity is
 * unused; dedicated/custom regions are org-scoped and never belong on the
 * public page.
 */
@Injectable()
export class StatusSyncService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(StatusSyncService.name)

  constructor(
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    private readonly dbHealth: TypeOrmHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    @InjectRedis() private readonly redis: Redis,
    private readonly incidentIoClient: IncidentIoClient,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    while (this.activeJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: STATUS_SYNC_LOCK_KEY })
  @TrackJobExecution()
  @LogExecution(STATUS_SYNC_LOCK_KEY)
  @WithInstrumentation()
  async syncStatus(): Promise<void> {
    if (!this.configService.get('incidentIo.enabled')) {
      return
    }
    const lockTtlSeconds = Math.ceil(
      (this.configService.get('incidentIo.probeTimeoutMs') +
        this.configService.get('incidentIo.timeoutMs') +
        LOCK_MARGIN_MS) /
        1000,
    )
    if (!(await this.redisLockProvider.lock(STATUS_SYNC_LOCK_KEY, lockTtlSeconds))) {
      return
    }

    try {
      // Evaluators are independent on purpose: with the database down, the
      // boxes/ingress evaluators reject while the api evaluator still reports
      // exactly that failure.
      const evaluations = await Promise.allSettled([
        this.evaluateApi(),
        this.evaluateBoxes(),
        this.evaluateBoxIngress(),
      ])
      for (const evaluation of evaluations) {
        if (evaluation.status === 'rejected') {
          // A crashed evaluator is a defect in the probe, not a component
          // outage: skip its components this tick rather than declare one.
          this.logger.error(`Status evaluator failed: ${this.describe(evaluation.reason)}`)
          continue
        }
        for (const observation of evaluation.value) {
          await this.reconcile(observation)
        }
      }
      // Pinged only after a completed evaluation pass: a wedged evaluator must
      // look dead to incident.io, not healthy. Rejected sends above do not
      // block it — incident.io refusing an event is not reporter death.
      await this.pingHeartbeat()
    } finally {
      await this.redisLockProvider.unlock(STATUS_SYNC_LOCK_KEY)
    }
  }

  private async evaluateApi(): Promise<ComponentObservation[]> {
    const timeout = this.configService.get('incidentIo.probeTimeoutMs')
    const failedDependencies: string[] = []
    if (await this.checkFails('database', () => this.dbHealth.pingCheck('database', { timeout }))) {
      failedDependencies.push('database')
    }
    if (await this.checkFails('redis', () => this.redisHealth.isHealthy('redis'))) {
      failedDependencies.push('redis')
    }
    return [
      {
        id: 'api',
        component: 'api',
        title: 'API degraded',
        healthy: failedDependencies.length === 0,
        detail:
          failedDependencies.length === 0
            ? 'Database and Redis reachable'
            : `API dependency check failed: ${failedDependencies.join(', ')}`,
      },
    ]
  }

  /**
   * Terminus indicators disagree about failure: legacy ones throw a
   * HealthCheckError while HealthIndicatorService-based ones return a `down`
   * result. Treat both — and any unexpected shape — as failed.
   */
  private async checkFails(key: string, check: () => Promise<Record<string, { status: string }>>): Promise<boolean> {
    try {
      const result = await check()
      return result?.[key]?.status !== 'up'
    } catch {
      return true
    }
  }

  private async evaluateBoxes(): Promise<ComponentObservation[]> {
    const sharedRegionIds = (await this.sharedRegions()).map((region) => region.id)
    if (sharedRegionIds.length === 0) {
      return []
    }
    // INITIALIZING is the birth state (fleet expansion must not page) and
    // DISABLED/DECOMMISSIONED/unschedulable/draining are operator intent —
    // only runners meant to carry traffic count.
    const runners = await this.runnerRepository.find({
      select: ['region', 'state'],
      where: {
        region: In(sharedRegionIds),
        state: In([RunnerState.READY, RunnerState.UNRESPONSIVE]),
        unschedulable: false,
        draining: false,
      },
    })

    const byRegion = new Map<string, { total: number; unresponsive: number }>()
    for (const runner of runners) {
      const counts = byRegion.get(runner.region) ?? { total: 0, unresponsive: 0 }
      counts.total += 1
      if (runner.state === RunnerState.UNRESPONSIVE) {
        counts.unresponsive += 1
      }
      byRegion.set(runner.region, counts)
    }

    return [...byRegion.entries()].map(([region, counts]) => ({
      id: `boxes-${region}`,
      component: 'boxes' as const,
      region,
      title: `Boxes degraded (${region})`,
      healthy: counts.unresponsive === 0,
      detail:
        counts.unresponsive === 0
          ? `All ${counts.total} runners responsive`
          : `Unresponsive runners: ${counts.unresponsive}/${counts.total}`,
    }))
  }

  private async evaluateBoxIngress(): Promise<ComponentObservation[]> {
    const probeable = (await this.sharedRegions()).filter((region) => region.proxyUrl)
    return Promise.all(probeable.map((region) => this.probeIngress(region)))
  }

  /** Never throws: an observed probe failure is data, not an evaluator crash. */
  private async probeIngress(region: Region): Promise<ComponentObservation> {
    const url = `${region.proxyUrl?.replace(/\/+$/, '')}/health`
    const observation = {
      id: `box-ingress-${region.id}`,
      component: 'box-ingress' as const,
      region: region.id,
      title: `Box Ingress degraded (${region.id})`,
    }
    try {
      await axios.get(url, { timeout: this.configService.get('incidentIo.probeTimeoutMs') })
      return { ...observation, healthy: true, detail: `GET ${url} ok` }
    } catch (error) {
      return { ...observation, healthy: false, detail: `GET ${url} failed: ${this.describe(error)}` }
    }
  }

  /** Dedicated/custom regions are org-scoped — never on the public page. */
  private sharedRegions(): Promise<Region[]> {
    return this.regionRepository.find({ where: { regionType: RegionType.SHARED } })
  }

  private async reconcile(observation: ComponentObservation): Promise<void> {
    const observed: AlertStatus = observation.healthy ? 'resolved' : 'firing'
    const stateKey = `${STATE_KEY_PREFIX}${observation.id}`
    const state = await this.readState(stateKey)

    // Unknown last-sent state (first tick, or Redis lost it): send what we see
    // now, undamped — a recovery after a Redis flush must still emit resolved
    // or the incident.io alert fires forever. Duplicates are no-ops thanks to
    // the dedup key.
    if (state === null) {
      if (await this.send(observation, observed)) {
        await this.writeState(stateKey, { sent: observed, streak: 0 })
      }
      return
    }

    if (state.sent === observed) {
      await this.writeState(stateKey, { sent: state.sent, streak: 0 })
      return
    }

    const streak = Math.min(state.streak + 1, FIRE_AFTER_TICKS)
    const threshold = observed === 'firing' ? FIRE_AFTER_TICKS : RESOLVE_AFTER_TICKS
    if (streak < threshold) {
      await this.writeState(stateKey, { sent: state.sent, streak })
      return
    }

    if (await this.send(observation, observed)) {
      await this.writeState(stateKey, { sent: observed, streak: 0 })
    } else {
      // Keep the streak at threshold so the next tick retries the send.
      await this.writeState(stateKey, { sent: state.sent, streak })
    }
  }

  private async send(observation: ComponentObservation, status: AlertStatus): Promise<boolean> {
    const dedupPrefix = this.configService.get('incidentIo.dedupPrefix')
    const event: AlertEvent = {
      title: observation.title,
      status,
      deduplicationKey: `${dedupPrefix}-${observation.id}`,
      description: status === 'resolved' ? `Recovered. ${observation.detail}` : observation.detail,
      metadata: {
        component: observation.component,
        ...(observation.region ? { region: observation.region } : {}),
        prefix: dedupPrefix,
        source: 'boxlite-status-sync',
      },
    }
    try {
      await this.incidentIoClient.sendAlertEvent(event)
      this.logger.log(`Sent ${status} for ${observation.id}: ${observation.detail}`)
      return true
    } catch (error) {
      this.logger.error(`Failed to send ${status} for ${observation.id}: ${this.describe(error)}`)
      return false
    }
  }

  private async readState(key: string): Promise<ComponentSendState | null> {
    const raw = await this.redis.get(key)
    if (!raw) {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as ComponentSendState
      if ((parsed.sent === 'firing' || parsed.sent === 'resolved') && Number.isInteger(parsed.streak)) {
        return parsed
      }
    } catch {
      // fall through — junk state is the same as no state
    }
    return null
  }

  private writeState(key: string, state: ComponentSendState): Promise<unknown> {
    return this.redis.set(key, JSON.stringify(state), 'EX', STATE_TTL_SECONDS)
  }

  private async pingHeartbeat(): Promise<void> {
    if (!this.configService.get('incidentIo.heartbeatId')) {
      return
    }
    try {
      await this.incidentIoClient.pingHeartbeat()
    } catch (error) {
      this.logger.error(`Heartbeat ping failed: ${this.describe(error)}`)
    }
  }

  private describe(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
    }
    return error instanceof Error ? error.message : String(error)
  }
}
