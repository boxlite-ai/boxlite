// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildPublicStatusSnapshot,
  deriveEcsServiceStatus,
  deriveRunnerStatus,
  type EcsServiceObservation,
  type RunnerObservation,
} from './collector-core.js'

const NOW = new Date('2026-08-25T00:02:00.000Z')

const healthyEcs: EcsServiceObservation = {
  isActive: true,
  desiredCount: 2,
  runningCount: 2,
  targetHealth: ['healthy', 'healthy'],
}

const healthyRunner: RunnerObservation = {
  id: 'runner-1',
  isRunning: true,
  instanceStatusPassed: true,
  systemStatusPassed: true,
  heartbeat: { healthy: true, recordedAt: new Date('2026-08-25T00:01:00.000Z') },
}

describe('public status aggregation', () => {
  test('maps ECS capacity and target health to public availability', () => {
    assert.equal(deriveEcsServiceStatus(healthyEcs), 'operational')
    assert.equal(deriveEcsServiceStatus({ ...healthyEcs, runningCount: 1 }), 'partial_outage')
    assert.equal(deriveEcsServiceStatus({ ...healthyEcs, targetHealth: ['healthy'] }), 'partial_outage')
    assert.equal(deriveEcsServiceStatus({ ...healthyEcs, targetHealth: ['unhealthy'] }), 'outage')
    assert.equal(deriveEcsServiceStatus(undefined), 'outage')
  })

  test('requires a fresh application heartbeat as well as EC2 health', () => {
    assert.equal(deriveRunnerStatus([healthyRunner], NOW), 'operational')
    assert.equal(
      deriveRunnerStatus(
        [healthyRunner, { ...healthyRunner, id: 'runner-2', heartbeat: { healthy: false, recordedAt: NOW } }],
        NOW,
      ),
      'partial_outage',
    )
    assert.equal(
      deriveRunnerStatus(
        [{ ...healthyRunner, heartbeat: { healthy: true, recordedAt: new Date('2026-08-24T23:59:59.999Z') } }],
        NOW,
      ),
      'outage',
    )
  })

  test('projects only region and API, Runner, Proxy public state', () => {
    const snapshot = buildPublicStatusSnapshot(
      [{ id: 'ap-southeast-1', api: healthyEcs, proxy: healthyEcs, runners: [healthyRunner] }],
      NOW,
    )

    assert.deepEqual(snapshot, {
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      regions: [
        {
          id: 'ap-southeast-1',
          status: 'operational',
          services: [
            { id: 'api', name: 'API', status: 'operational' },
            { id: 'runner', name: 'Runner', status: 'operational' },
            { id: 'proxy', name: 'Proxy', status: 'operational' },
          ],
        },
      ],
    })
    assert.doesNotMatch(JSON.stringify(snapshot), /arn:|instanceId|cluster|desiredCount|targetHealth/)
  })
})
