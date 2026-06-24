import { describe, expect, it } from 'vitest'
import { getBoxContentTabs } from './dashboard-features'

describe('dashboard feature gates', () => {
  it('exposes the base tabs without experiments', () => {
    expect(getBoxContentTabs({ experimentsEnabled: false })).toEqual(['overview'])
  })

  it('adds experiment tabs when experiments are enabled', () => {
    expect(getBoxContentTabs({ experimentsEnabled: true })).toEqual([
      'overview',
      'logs',
      'traces',
      'metrics',
      'spending',
    ])
  })
})
