// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export const STATUS_SCHEMA_VERSION = 1 as const
export const RUNNER_HEARTBEAT_NAMESPACE = 'BoxLite/PublicStatus'
export const RUNNER_HEARTBEAT_METRIC = 'RunnerHealthy'
export const RUNNER_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000

export type PublicServiceStatus = 'operational' | 'partial_outage' | 'outage'
export type PublicServiceId = 'api' | 'runner' | 'proxy'

export interface EcsServiceObservation {
  isActive: boolean
  desiredCount: number
  runningCount: number
  targetHealth: Array<'healthy' | 'unhealthy'>
}

export interface RunnerObservation {
  id: string
  isRunning: boolean
  instanceStatusPassed: boolean
  systemStatusPassed: boolean
  heartbeat?: {
    healthy: boolean
    recordedAt: Date
  }
}

export interface RegionObservation {
  id: string
  api?: EcsServiceObservation
  proxy?: EcsServiceObservation
  runners: RunnerObservation[]
}

export interface PublicStatusSnapshot {
  schemaVersion: typeof STATUS_SCHEMA_VERSION
  generatedAt: string
  regions: Array<{
    id: string
    status: PublicServiceStatus
    services: Array<{
      id: PublicServiceId
      name: 'API' | 'Runner' | 'Proxy'
      status: PublicServiceStatus
    }>
  }>
}

const STATUS_SEVERITY: Record<PublicServiceStatus, number> = {
  operational: 0,
  partial_outage: 1,
  outage: 2,
}

export function deriveEcsServiceStatus(observation: EcsServiceObservation | undefined): PublicServiceStatus {
  if (!observation || !observation.isActive || observation.desiredCount < 1 || observation.runningCount < 1) {
    return 'outage'
  }

  const healthyTargets = observation.targetHealth.filter((health) => health === 'healthy').length
  if (healthyTargets === 0) {
    return 'outage'
  }

  if (
    observation.runningCount < observation.desiredCount ||
    healthyTargets < observation.desiredCount ||
    healthyTargets < observation.targetHealth.length
  ) {
    return 'partial_outage'
  }

  return 'operational'
}

export function deriveRunnerStatus(
  observations: RunnerObservation[],
  now: Date,
  maxHeartbeatAgeMs = RUNNER_HEARTBEAT_MAX_AGE_MS,
): PublicServiceStatus {
  if (observations.length === 0) {
    return 'outage'
  }

  const healthyRunners = observations.filter((runner) => {
    const heartbeatAgeMs = runner.heartbeat
      ? now.getTime() - runner.heartbeat.recordedAt.getTime()
      : Number.POSITIVE_INFINITY
    return (
      runner.isRunning &&
      runner.instanceStatusPassed &&
      runner.systemStatusPassed &&
      runner.heartbeat?.healthy === true &&
      heartbeatAgeMs >= 0 &&
      heartbeatAgeMs <= maxHeartbeatAgeMs
    )
  }).length

  if (healthyRunners === 0) {
    return 'outage'
  }

  return healthyRunners === observations.length ? 'operational' : 'partial_outage'
}

export function buildPublicStatusSnapshot(regions: RegionObservation[], now = new Date()): PublicStatusSnapshot {
  const regionIds = new Set<string>()
  const publicRegions = regions.map((region) => {
    if (regionIds.has(region.id)) {
      throw new Error(`Duplicate status region: ${region.id}`)
    }
    regionIds.add(region.id)

    const services: PublicStatusSnapshot['regions'][number]['services'] = [
      { id: 'api', name: 'API', status: deriveEcsServiceStatus(region.api) },
      { id: 'runner', name: 'Runner', status: deriveRunnerStatus(region.runners, now) },
      { id: 'proxy', name: 'Proxy', status: deriveEcsServiceStatus(region.proxy) },
    ]
    const status = services.reduce<PublicServiceStatus>(
      (worst, service) => (STATUS_SEVERITY[service.status] > STATUS_SEVERITY[worst] ? service.status : worst),
      'operational',
    )

    return { id: region.id, status, services }
  })

  if (publicRegions.length === 0) {
    throw new Error('At least one status region is required')
  }

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    regions: publicRegions,
  }
}
