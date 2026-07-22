/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { applyResourceMultipliers, settleSegmentAgainstQuota } from './subscription-math'

const costs = { cpuCents: '40', memCents: '20', diskCents: '10', gpuCents: '30' }

it('applies resource-specific user multipliers', () => {
  expect(applyResourceMultipliers(costs, { cpu: '1.2', mem: '1', disk: '0.5', gpu: '2' })).toEqual({
    cpuCents: '48',
    memCents: '20',
    diskCents: '5',
    gpuCents: '60',
  })
})

it('covers the rated amount with quota before charging overage proportionally', () => {
  expect(
    settleSegmentAgainstQuota({
      resourceCosts: costs,
      quotaAvailablePreciseCents: '25',
      overageMultipliers: { cpu: '1.5', mem: '1.5', disk: '1', gpu: '1' },
    }),
  ).toEqual({
    quotaCoveredPreciseCents: '25',
    overagePreciseCents: '97.5',
    chargePreciseCents: '97.5',
  })
})

it('charges nothing when quota covers the full segment', () => {
  expect(
    settleSegmentAgainstQuota({
      resourceCosts: costs,
      quotaAvailablePreciseCents: '100',
      overageMultipliers: { cpu: '2', mem: '2', disk: '2', gpu: '2' },
    }),
  ).toEqual({ quotaCoveredPreciseCents: '100', overagePreciseCents: '0', chargePreciseCents: '0' })
})
