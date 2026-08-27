import { describe, expect, it } from 'vitest'
import type { OrganizationPlan, Plan } from '@/billing-api'
import { planConcurrencyLimit } from './plan-concurrency'

const organizationPlan = { planId: 'pro' } as OrganizationPlan

describe('planConcurrencyLimit', () => {
  it('reads a standard plan ceiling from the public catalog', () => {
    expect(planConcurrencyLimit(organizationPlan, [{ id: 'pro', concurrencyLimit: 100 } as Plan])).toBe(100)
  })

  it('keeps unlimited and custom plans distinct from a zero ceiling', () => {
    expect(planConcurrencyLimit(organizationPlan, [{ id: 'pro', concurrencyLimit: null } as Plan])).toBeNull()
    expect(planConcurrencyLimit({ ...organizationPlan, planId: 'custom' }, [])).toBeNull()
  })
})
