// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { PolicyPack } from '@pulumi/policy'

// eslint-disable-next-line @nx/enforce-module-boundaries -- The policy pack and deployment share one Runner identity model.
import { resolveRunnerInventory } from '../../runner/model/inventory.ts'
// eslint-disable-next-line @nx/enforce-module-boundaries -- The policy pack and deployment share one Runner state model.
import { parseRunnerStateBaseline } from '../../runner/model/state-baseline.ts'
import { createRunnerPolicies } from './definitions.ts'

const runnerInventory = resolveRunnerInventory(process.env)
const serializedRunnerStateBaseline = process.env.BOXLITE_RUNNER_STATE_BASELINE
if (!serializedRunnerStateBaseline) {
  throw new Error('BOXLITE_RUNNER_STATE_BASELINE is required')
}
const runnerStateBaseline = parseRunnerStateBaseline(serializedRunnerStateBaseline)

new PolicyPack('boxlite-runner-safety', {
  policies: createRunnerPolicies(runnerInventory, runnerStateBaseline),
})
