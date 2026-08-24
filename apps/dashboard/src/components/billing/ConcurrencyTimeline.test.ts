import { describe, expect, it } from 'vitest'
import { concurrencyAxisMaximum } from './ConcurrencyTimeline'

describe('concurrencyAxisMaximum', () => {
  it('keeps both the observed peak and the plan limit inside the chart', () => {
    expect(concurrencyAxisMaximum([{ time: 0, runningBoxes: 105 }], 100)).toBe(120)
    expect(concurrencyAxisMaximum([{ time: 0, runningBoxes: 30 }], 100)).toBe(120)
  })

  it('keeps an empty series readable', () => {
    expect(concurrencyAxisMaximum([], null)).toBe(2)
  })
})
