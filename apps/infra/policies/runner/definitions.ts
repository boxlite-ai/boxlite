// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// eslint-disable-next-line @nx/enforce-module-boundaries -- The policy pack and deployment share one Runner identity model.
import { resolveRunnerInventory } from '../../runner/model/inventory.ts'
import { validateRunnerResource, validateRunnerStack } from './validate.ts'

function reportViolations(violations: any, reportViolation: any) {
  for (const violation of violations) reportViolation(violation)
}

export function createRunnerPolicies(inventory: any, baseline?: any) {
  inventory ??= resolveRunnerInventory(process.env)
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Runner state baseline is required to create Runner policies')
  }
  return [
    {
      name: 'runner-instance-contract',
      description: 'Protects every declared Runner instance and preserves its control-plane identity.',
      enforcementLevel: 'mandatory' as const,
      validateResource(resource: any, reportViolation: any) {
        reportViolations(validateRunnerResource(resource, inventory, baseline), reportViolation)
      },
    },
    {
      name: 'runner-inventory-complete',
      description: 'Requires the previewed stack to contain every declared Runner exactly once.',
      enforcementLevel: 'mandatory' as const,
      validateStack(stack: any, reportViolation: any) {
        reportViolations(validateRunnerStack(stack.resources, inventory, baseline), reportViolation)
      },
    },
  ]
}

export default { createRunnerPolicies }
