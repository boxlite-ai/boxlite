import { assertWithinPerBoxLimits } from '../services/per-box-limits'

const limits = { maxCpuPerBox: 4, maxMemoryPerBox: 1, maxDiskPerBox: 10 }
describe('GiB memory admission', () => {
  it.each([256, 257, 512, 513, 768, 1024])('accepts exactly %i MiB', (mib) => {
    expect(() => assertWithinPerBoxLimits(1, mib / 1024, 1, limits)).not.toThrow()
  })
  it.each([0.3, 0.50098, 256.5 / 1024])('accepts unaligned %s GiB', (gib) => {
    expect(() => assertWithinPerBoxLimits(1, gib, 1, limits)).not.toThrow()
  })
  it.each([0, -1, 255, 255.5, NaN, Infinity, 2147483647.25, 2147483648])('rejects invalid %s MiB', (mib) => {
    expect(() => assertWithinPerBoxLimits(1, mib / 1024, 1, limits)).toThrow(/between 256/)
  })
  it('enforces the organization limit to one MiB', () => {
    expect(() => assertWithinPerBoxLimits(1, 1025 / 1024, 1, limits)).toThrow(/per-box limit/)
  })
  it('compares the original GiB quota without rounding storage values', () => {
    const fractionalLimit = { ...limits, maxMemoryPerBox: 0.3 }
    expect(() => assertWithinPerBoxLimits(1, 0.3, 1, fractionalLimit)).not.toThrow()
    expect(() => assertWithinPerBoxLimits(1, 0.30001, 1, fractionalLimit)).toThrow(/per-box limit/)
  })
})
