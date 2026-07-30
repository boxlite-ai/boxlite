// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const { resolveRunnerInventory } = require('../../scripts/runner-inventory.cjs')
const { validateRunnerResource, validateRunnerStack } = require('./validate.cjs')

function reportViolations(violations, reportViolation) {
  for (const violation of violations) reportViolation(violation)
}

function createRunnerPolicies(inventory, baseline) {
  inventory ??= resolveRunnerInventory(process.env)
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Runner state baseline is required to create Runner policies')
  }
  return [
    {
      name: 'runner-instance-contract',
      description: 'Protects every declared Runner instance and preserves its control-plane identity.',
      enforcementLevel: 'mandatory',
      validateResource(resource, reportViolation) {
        reportViolations(validateRunnerResource(resource, inventory, baseline), reportViolation)
      },
    },
    {
      name: 'runner-inventory-complete',
      description: 'Requires the previewed stack to contain every declared Runner exactly once.',
      enforcementLevel: 'mandatory',
      validateStack(stack, reportViolation) {
        reportViolations(validateRunnerStack(stack.resources, inventory, baseline), reportViolation)
      },
    },
  ]
}

module.exports = { createRunnerPolicies }
