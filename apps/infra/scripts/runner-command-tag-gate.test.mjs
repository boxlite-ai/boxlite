// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateRunnerCommandTagGate } from './runner-command-tag-gate.mjs'
import runnerInventory from './runner-inventory.cjs'

const { RUNNER_ROLE_TAG, RUNNER_ROLE_VALUE, RUNNER_STAGE_TAG, resolveRunnerInventory } = runnerInventory
const STAGE = 'dev'
const IDS = ['i-00000000000000001', 'i-00000000000000002']

function baseline(count = 1) {
  return {
    version: 4,
    stage: STAGE,
    resources: Object.fromEntries(
      resolveRunnerInventory({ RUNNERS: String(count) }).map((runner, index) => [
        runner.resourceName,
        { instanceId: IDS[index] },
      ]),
    ),
  }
}

function instance(id, { state = 'running', tags = {} } = {}) {
  return {
    InstanceId: id,
    State: { Name: state },
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
  }
}

function authorizedInstance(id = IDS[0]) {
  return instance(id, {
    tags: { [RUNNER_STAGE_TAG]: STAGE, [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
  })
}

function evaluate(overrides = {}) {
  return evaluateRunnerCommandTagGate({
    previousEnabled: false,
    stage: STAGE,
    desiredInventory: resolveRunnerInventory({}),
    baseline: baseline(),
    instances: [authorizedInstance()],
    ...overrides,
  })
}

test('enables the Runner command tag gate only after every existing declared Runner has exact tags', () => {
  assert.equal(evaluate(), true)
  assert.equal(evaluate({ instances: [instance(IDS[0])] }), false)
  const noTags = instance(IDS[0])
  delete noTags.Tags
  assert.equal(evaluate({ instances: [noTags] }), false)
  assert.equal(
    evaluate({
      instances: [
        instance(IDS[0], { tags: { [RUNNER_STAGE_TAG]: 'prod', [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE } }),
      ],
    }),
    false,
  )
  assert.equal(
    evaluate({
      instances: [instance(IDS[0], { tags: { [RUNNER_STAGE_TAG]: STAGE, [RUNNER_ROLE_TAG]: 'api' } })],
    }),
    false,
  )
})

test('never downgrades an enabled gate and fails if an existing Runner loses authorization tags', () => {
  assert.equal(evaluate({ previousEnabled: true }), true)
  for (const instances of [
    [instance(IDS[0])],
    [instance(IDS[0], { tags: { [RUNNER_STAGE_TAG]: 'prod', [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE } })],
  ]) {
    assert.throws(
      () => evaluate({ previousEnabled: true, instances }),
      /enabled Runner command tag gate cannot be downgraded/i,
    )
  }
})

test('requires every baseline instance to exist uniquely and be nonterminated', () => {
  assert.throws(() => evaluate({ instances: [] }), /Runner state instance.*missing/i)
  assert.throws(
    () => evaluate({ instances: [authorizedInstance(), authorizedInstance()] }),
    /duplicate EC2 instance/i,
  )
  assert.throws(
    () => evaluate({ instances: [instance(IDS[0], { state: 'terminated' })] }),
    /nonterminated/i,
  )

  for (const invalidId of ['i-000000000', 'i-0000000000000000']) {
    assert.throws(
      () =>
        evaluate({
          baseline: {
            version: 4,
            stage: STAGE,
            resources: { Runner: { instanceId: invalidId } },
          },
          instances: [authorizedInstance(invalidId)],
        }),
      /invalid.*instance id/i,
    )
    assert.throws(
      () => evaluate({ instances: [authorizedInstance(invalidId)] }),
      /invalid.*EC2 instance/i,
    )
  }
})

test('ignores untagged and exact other-stage Runners but rejects ambiguous auth-tagged extras', () => {
  const untagged = instance('i-00000000000000008')
  delete untagged.Tags
  assert.equal(evaluate({ instances: [authorizedInstance(), untagged] }), true)
  assert.equal(
    evaluate({
      instances: [
        authorizedInstance(),
        instance('i-00000000000000009', {
          tags: { [RUNNER_STAGE_TAG]: 'prod', [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
        }),
      ],
    }),
    true,
  )

  for (const tags of [
    { [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
    { [RUNNER_STAGE_TAG]: 'prod' },
    { [RUNNER_STAGE_TAG]: 'prod-blue', [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
    { [RUNNER_STAGE_TAG]: 'prod', [RUNNER_ROLE_TAG]: 'api' },
    { [RUNNER_STAGE_TAG]: STAGE, [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
    { [RUNNER_STAGE_TAG.toUpperCase()]: 'prod', [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE },
  ]) {
    assert.throws(
      () =>
        evaluate({
          instances: [authorizedInstance(), instance('i-00000000000000009', { tags })],
        }),
      /extra|authorization tag/i,
    )
  }
})

test('rejects duplicate case-variant authorization tags on a state-owned Runner', () => {
  const duplicateTagInstance = authorizedInstance()
  duplicateTagInstance.Tags.push({ Key: RUNNER_STAGE_TAG.toUpperCase(), Value: STAGE })
  assert.throws(
    () => evaluate({ instances: [duplicateTagInstance] }),
    /(?:case-variant|duplicate).*authorization tag/i,
  )
})

test('allows a desired new Runner to be absent only after the tag gate is already enabled', () => {
  const desiredInventory = resolveRunnerInventory({ RUNNERS: '2' })
  assert.equal(evaluate({ desiredInventory }), false)
  assert.equal(evaluate({ desiredInventory, previousEnabled: true }), true)

  assert.throws(
    () =>
      evaluate({
        previousEnabled: true,
        baseline: { version: 4, stage: STAGE, resources: {} },
        instances: [],
      }),
    /default Runner.*state/i,
  )
})
