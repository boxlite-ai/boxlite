// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import policy from '@pulumi/policy'

import runnerInventoryModule from '../../scripts/runner-inventory.cjs'
import runnerStateBaselineModule from '../../scripts/runner-state-baseline.cjs'
import runnerPolicyDefinitions from './definitions.cjs'

const { PolicyPack } = policy
const { resolveRunnerInventory } = runnerInventoryModule
const { parseRunnerStateBaseline } = runnerStateBaselineModule
const { createRunnerPolicies } = runnerPolicyDefinitions

const runnerInventory = resolveRunnerInventory(process.env)
const serializedRunnerStateBaseline = process.env.BOXLITE_RUNNER_STATE_BASELINE
if (!serializedRunnerStateBaseline) {
  throw new Error('BOXLITE_RUNNER_STATE_BASELINE is required')
}
const runnerStateBaseline = parseRunnerStateBaseline(serializedRunnerStateBaseline)

new PolicyPack('boxlite-runner-safety', {
  policies: createRunnerPolicies(runnerInventory, runnerStateBaseline),
})
