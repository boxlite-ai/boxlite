// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectAndPublish, parseEcsServiceArn, requireCollectorConfig } from './collector.js'

const NOW = new Date('2026-08-25T00:02:00.000Z')

describe('public status collector boundary', () => {
  test('requires an explicit, unique regional collection boundary', () => {
    assert.deepEqual(
      requireCollectorConfig({
        STATUS_SNAPSHOT_BUCKET: 'status-bucket',
        STATUS_STAGE: 'prod',
        STATUS_REGIONS: 'ap-southeast-1,us-east-1',
        STATUS_RUNNERS: 'runner-1,runner-2',
      }),
      {
        bucketName: 'status-bucket',
        stage: 'prod',
        regions: ['ap-southeast-1', 'us-east-1'],
        runnerIds: ['runner-1', 'runner-2'],
      },
    )
    assert.throws(
      () =>
        requireCollectorConfig({
          STATUS_SNAPSHOT_BUCKET: 'status-bucket',
          STATUS_STAGE: 'prod',
          STATUS_REGIONS: 'ap-southeast-1,ap-southeast-1',
          STATUS_RUNNERS: 'runner-1',
        }),
      /must not contain duplicates/,
    )
  })

  test('parses only regional ECS long service ARNs', () => {
    assert.deepEqual(
      parseEcsServiceArn('arn:aws:ecs:ap-southeast-1:123456789012:service/boxlite-prod/boxlite-prod-Api'),
      { region: 'ap-southeast-1', cluster: 'boxlite-prod' },
    )
    assert.throws(() => parseEcsServiceArn('arn:aws:ecs:ap-southeast-1:123456789012:service/legacy'))
  })

  test('does not replace the last verified snapshot when collection fails', async () => {
    let writes = 0
    await assert.rejects(
      collectAndPublish(
        { bucketName: 'status-bucket', stage: 'prod', regions: ['ap-southeast-1'], runnerIds: ['runner-1'] },
        NOW,
        {
          collectRegion: async () => {
            throw new Error('AWS source unavailable')
          },
          putSnapshot: async () => {
            writes += 1
          },
        },
      ),
      /AWS source unavailable/,
    )
    assert.equal(writes, 0)
  })
})
