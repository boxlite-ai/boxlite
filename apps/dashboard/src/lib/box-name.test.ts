import { describe, expect, it } from 'vitest'

import { generateBoxName } from './box-name'

describe('generateBoxName', () => {
  it('produces a lowercase "adjective-animal" DNS label', () => {
    for (let i = 0; i < 200; i++) {
      const name = generateBoxName()
      expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    }
  })

  it('varies across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generateBoxName())
    expect(seen.size).toBeGreaterThan(1)
  })
})
