import { resizeTarget, validResources } from './resize-resources'

describe('resize with fractional CPU allocations', () => {
  const resources = { cpus: 0.125, memory_mib: 1024, max_cpus: 16, max_memory_mib: 8192 }

  it.each([0.125, 0.5, 1.5, 16])('preserves %s CPUs for queries and memory-only growth', (cpus) => {
    const current = { ...resources, cpus }
    expect(validResources(current)).toBe(true)
    expect(resizeTarget({}, current)).toEqual({ cpus, memory_mib: 1024 })
    expect(resizeTarget({ memory_mib: 1537 }, current)).toEqual({ cpus, memory_mib: 1664 })
  })

  it.each([0, 0.124, 0.1251, 16.001, NaN, Infinity])('rejects invalid observed allocation %s', (cpus) => {
    expect(validResources({ ...resources, cpus })).toBe(false)
  })

  it('allows integer CPU growth and rejects shrinking a fractional allocation', () => {
    const current = { ...resources, cpus: 1.5 }
    expect(resizeTarget({ cpus: 2 }, current)).toEqual({ cpus: 2, memory_mib: 1024 })
    expect(() => resizeTarget({ cpus: 1 }, current)).toThrow('Resize must grow')
  })
})

describe('resize with exact MiB allocations', () => {
  const current = { cpus: 1, memory_mib: 300 }

  it.each([
    [undefined, 300],
    [300, 300],
    [301, 428],
    [428, 428],
    [429, 556],
    [500, 556],
  ])('rounds memory target %s relative to the current allocation to %s', (requested, expected) => {
    expect(resizeTarget({ cpus: 2, memory_mib: requested }, current)).toEqual({ cpus: 2, memory_mib: expected })
  })

  it.each([0, 299])('rejects shrinking to %s MiB before rounding', (memory_mib) => {
    expect(() => resizeTarget({ memory_mib }, current)).toThrow('Resize must grow')
  })

  it('rejects an aligned target that overflows the MiB storage column', () => {
    expect(() => resizeTarget({ memory_mib: 2147483521 }, { cpus: 1, memory_mib: 2147483520 })).toThrow('Memory')
  })

  it('allows the largest representable MiB target when the growth is aligned', () => {
    expect(resizeTarget({ memory_mib: 2147483647 }, { cpus: 1, memory_mib: 2147483519 })).toEqual({
      cpus: 1,
      memory_mib: 2147483647,
    })
  })
})
