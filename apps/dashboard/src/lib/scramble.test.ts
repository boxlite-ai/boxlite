import { describe, expect, it } from 'vitest'

import { scrambleFrame } from './scramble'

describe('scrambleFrame', () => {
  it('reveals the whole target once progress reaches 1', () => {
    expect(scrambleFrame('cozy-otter', 1)).toBe('cozy-otter')
    expect(scrambleFrame('cozy-otter', 5)).toBe('cozy-otter')
  })

  it('locks a left-to-right prefix proportional to progress', () => {
    // 10-char target, 0.5 progress -> first 5 chars revealed.
    expect(scrambleFrame('cozy-otter', 0.5).slice(0, 5)).toBe('cozy-')
  })

  it('keeps the target length and box-name charset while scrambling', () => {
    const frame = scrambleFrame('cozy-otter', 0)
    expect(frame).toHaveLength('cozy-otter'.length)
    expect(frame).toMatch(/^[a-z-]+$/)
  })
})
