// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateDeploymentPreview } from './deployment-preview.mjs'

const runnerChange = ({
  name = 'Runner',
  op = 'update',
  detailedDiff = { __provider: { diffKind: 'update', inputDiff: true } },
  protect = true,
} = {}) => ({
  op,
  urn: `urn:pulumi:dev::boxlite::aws:ec2/instance:Instance::${name}`,
  type: 'aws:ec2/instance:Instance',
  old: { protect: true },
  new: { protect },
  detailedDiff,
})

test('accepts provider and tag-only updates to protected Runner instances', () => {
  const preview = [
    {
      op: 'replace',
      urn: 'urn:pulumi:dev::boxlite::aws:ecs/service:Service::ApiService',
      type: 'aws:ecs/service:Service',
      old: { protect: false },
      new: { protect: false },
      detailedDiff: {},
    },
    runnerChange({
      detailedDiff: {
        __provider: { diffKind: 'update', inputDiff: true },
        'tags["boxlite:control-plane-runner-name"]': { diffKind: 'add', inputDiff: true },
        'tagsAll["boxlite:control-plane-runner-name"]': { diffKind: 'add', inputDiff: false },
      },
    }),
    runnerChange({ name: 'Runner-runner-2', detailedDiff: { tags: { diffKind: 'update', inputDiff: true } } }),
  ]

  assert.deepEqual(validateDeploymentPreview(JSON.stringify(preview)), {
    changeCount: 3,
    runnerUpdates: [
      {
        name: 'Runner',
        paths: [
          '__provider',
          'tags["boxlite:control-plane-runner-name"]',
          'tagsAll["boxlite:control-plane-runner-name"]',
        ],
      },
      { name: 'Runner-runner-2', paths: ['tags'] },
    ],
  })
})

test('rejects Runner creates even when they are protected', () => {
  const create = runnerChange({ name: 'Runner-runner-2', op: 'create' })

  assert.throws(() => validateDeploymentPreview(JSON.stringify([create])), /unsafe Runner deployment plan/)
  assert.throws(
    () => validateDeploymentPreview(JSON.stringify([{ ...create, new: { protect: false } }])),
    /unsafe Runner deployment plan/,
  )
})

test('rejects disruptive or unexplained Runner operations', () => {
  const unsafeChanges = [
    runnerChange({ op: 'replace' }),
    runnerChange({ op: 'delete', protect: false }),
    runnerChange({ name: 'Runner-runner-2', op: 'create' }),
    { ...runnerChange({ op: 'replace' }), type: 'aws:ec2/launchTemplate:LaunchTemplate' },
    {
      ...runnerChange({ name: 'Canary', op: 'create' }),
      new: { protect: true, inputs: { tags: { Name: 'boxlite-runner-3' } } },
    },
    runnerChange({ detailedDiff: { instanceType: { diffKind: 'update', inputDiff: true } } }),
    runnerChange({ detailedDiff: {} }),
  ]

  for (const change of unsafeChanges) {
    assert.throws(() => validateDeploymentPreview(JSON.stringify([change])), /unsafe Runner deployment plan/)
  }
})

test('rejects malformed SST diff output', () => {
  assert.throws(() => validateDeploymentPreview('not JSON'), /valid JSON/)
  assert.throws(() => validateDeploymentPreview('{}'), /JSON array/)
  assert.throws(() => validateDeploymentPreview('[{"op":"update"}]'), /valid resource change/)
})
