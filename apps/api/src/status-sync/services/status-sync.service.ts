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
import { RedisLockProvider, withRedisLockLease } from '../../box/common/redis-lock.provider'
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
 * Safety margin the initial lease keeps over one probe plus one send; the
 * lease then renews itself at half-TTL for as long as the tick runs, so a
 * multi-send tick cannot outlive it and hand the lock to a second replica.
 */
const LOCK_MARGIN_MS = 30_000

/** Consecutive bad ticks before a public "down" — ~90s of sustained failure. */
const FIRE_AFTER_TICKS = 3
/** Consecutive good ticks before a public recovery — absorbs one-tick blips. */
const RESOLVE_AFTER_TICKS = 2
/** Damping state survives deploys but self-clears if the sweep ever misses. */
const STATE_TTL_SECONDS = 86_400
const STATE_KEY_PREFIX = 'status-sync:component:'
/** Set of every component id with damping state — what the retirement sweep diffs against. */
const STATE_SET_KEY = 'status-sync:components'

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
 * region's proxy /health over its public URL). A component that vanishes
 * (region deleted, proxyUrl cleared, fleet emptied) is retired: its firing
 * alert is resolved before its state is dropped. Deliberate v1 blind spots:
 * per-runner serviceHealth granularity is unused, and dedicated/custom
 * regions are org-scoped so they never reach the public page.
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
    const lease = await this.redisLockProvider.acquireLease(STATUS_SYNC_LOCK_KEY, lockTtlSeconds)
    if (!lease) {
      return
    }

    await withRedisLockLease(
      lease,
      async (signal) => {
        // Evaluators are independent on purpose: with the database down, the
        // boxes/ingress evaluators reject while the api evaluator still
        // reports exactly that failure.
        const evaluations = await Promise.allSettled([
          this.evaluateApi(),
          this.evaluateBoxes(),
          this.evaluateBoxIngress(),
        ])

        const observedIds = new Set<string>()
        let everyEvaluatorCompleted = true
        for (const evaluation of evaluations) {
          if (evaluation.status === 'rejected') {
            // A crashed evaluator is a defect in the probe, not a component
            // outage: skip its components this tick rather than declare one.
            this.logger.error(`Status evaluator failed: ${this.describe(evaluation.reason)}`)
            everyEvaluatorCompleted = false
            continue
          }
          for (const observation of evaluation.value) {
            signal.throwIfAborted()
            observedIds.add(observation.id)
            await this.reconcile(observation)
          }
        }

        // Only a fully observed tick can prove absence: with any evaluator
        // down, "missing" is indistinguishable from "unobserved".
        if (everyEvaluatorCompleted) {
          await this.retireVanished(observedIds, signal)
        }

        // Pinged only after a completed evaluation pass: a wedged evaluator
        // must look dead to incident.io, not healthy. Rejected sends above do
        // not block it — incident.io refusing an event is not reporter death.
        await this.pingHeartbeat()
      },
      (releaseError) => this.logger.error(`Suppressed lease release error: ${this.describe(releaseError)}`),
    )
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
        ...this.observationShape('api'),
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
      ...this.observationShape(`boxes-${region}`),
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
    const observation = this.observationShape(`box-ingress-${region.id}`)
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

  /**
   * Rebuilds an observation's identity (component, region, title, dedup key
   * tail) from its stable id, so the retirement sweep can resolve alerts for
   * components the evaluators no longer return.
   */
  private observationShape(id: string): Omit<ComponentObservation, 'healthy' | 'detail'> {
    if (id.startsWith('boxes-')) {
      const region = id.slice('boxes-'.length)
      return { id, component: 'boxes', region, title: `Boxes degraded (${region})` }
    }
    if (id.startsWith('box-ingress-')) {
      const region = id.slice('box-ingress-'.length)
      return { id, component: 'box-ingress', region, title: `Box Ingress degraded (${region})` }
    }
    return { id, component: 'api', title: 'API degraded' }
  }

  private async reconcile(observation: ComponentObservation): Promise<void> {
    const observed: AlertStatus = observation.healthy ? 'resolved' : 'firing'
    const state = await this.readState(observation.id)

    // Unknown last-sent state (first tick, or Redis lost it) is asymmetric on
    // purpose: an observed recovery is sent undamped, because after a Redis
    // flush mid-incident the resolved event must still reach incident.io or
    // its alert fires forever (duplicates are no-ops thanks to the dedup
    // key). An observed failure only seeds the streak — a single bad probe on
    // a component's first tick must not bypass FIRE_AFTER_TICKS.
    if (state === null) {
      if (observed === 'resolved') {
        if (await this.send(observation, observed)) {
          await this.writeState(observation.id, { sent: observed, streak: 0 })
        }
      } else {
        await this.writeState(observation.id, { sent: 'resolved', streak: 1 })
      }
      return
    }

    if (state.sent === observed) {
      await this.writeState(observation.id, { sent: state.sent, streak: 0 })
      return
    }

    const streak = Math.min(state.streak + 1, FIRE_AFTER_TICKS)
    const threshold = observed === 'firing' ? FIRE_AFTER_TICKS : RESOLVE_AFTER_TICKS
    if (streak < threshold) {
      await this.writeState(observation.id, { sent: state.sent, streak })
      return
    }

    if (await this.send(observation, observed)) {
      await this.writeState(observation.id, { sent: observed, streak: 0 })
    } else {
      // Keep the streak at threshold so the next tick retries the send.
      await this.writeState(observation.id, { sent: state.sent, streak })
    }
  }

  /**
   * Resolves alerts for components the evaluators stopped returning — a
   * deleted region, a cleared proxyUrl, an emptied fleet. Without this, the
   * incident.io alert would stay firing forever: the state TTL only forgets
   * our local damping, never their alert.
   */
  private async retireVanished(observedIds: Set<string>, signal: AbortSignal): Promise<void> {
    const knownIds = await this.redis.smembers(STATE_SET_KEY)
    for (const id of knownIds) {
      if (observedIds.has(id)) {
        continue
      }
      signal.throwIfAborted()
      const state = await this.readState(id)
      if (state?.sent === 'firing') {
        const retired = {
          ...this.observationShape(id),
          detail: 'Component no longer observed (region removed or fleet emptied); retiring.',
        }
        if (!(await this.send(retired, 'resolved'))) {
          continue // keep the state; next tick retries the retirement
        }
      }
      await this.redis.del(`${STATE_KEY_PREFIX}${id}`)
      await this.redis.srem(STATE_SET_KEY, id)
      this.logger.log(`Retired status component ${id}`)
    }
  }

  private async send(observation: Omit<ComponentObservation, 'healthy'>, status: AlertStatus): Promise<boolean> {
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

  private async readState(id: string): Promise<ComponentSendState | null> {
    const raw = await this.redis.get(`${STATE_KEY_PREFIX}${id}`)
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

  private async writeState(id: string, state: ComponentSendState): Promise<void> {
    await this.redis.set(`${STATE_KEY_PREFIX}${id}`, JSON.stringify(state), 'EX', STATE_TTL_SECONDS)
    await this.redis.sadd(STATE_SET_KEY, id)
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
