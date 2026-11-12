import { assertWithinPerBoxLimits } from '../services/per-box-limits'

const limits = { maxCpuPerBox: 4, maxMemoryPerBox: 1, maxDiskPerBox: 10 }
describe('integer MiB memory admission', () => {
  it.each([256, 257, 512, 513, 768, 1024])('accepts exactly %i MiB', (mib) => {
    expect(() => assertWithinPerBoxLimits(1, mib / 1024, 1, limits)).not.toThrow()
  })
  it.each([0, -1, 255, 256.5, NaN, Infinity, 2147483648])('rejects invalid %s MiB', (mib) => {
    expect(() => assertWithinPerBoxLimits(1, mib / 1024, 1, limits)).toThrow(/integer.*256/)
  })
  it('enforces the organization limit to one MiB', () => {
    expect(() => assertWithinPerBoxLimits(1, 1025 / 1024, 1, limits)).toThrow(/per-box limit/)
  })
})
