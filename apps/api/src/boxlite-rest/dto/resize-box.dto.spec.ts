import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { ResizeBoxDto } from './resize-box.dto'

describe('ResizeBoxDto CPU allocation', () => {
  it.each([0.125, 0.126, 0.5, 0.75, 1, 1.5, 16])('accepts %s CPUs', async (cpus) => {
    expect(await validate(plainToInstance(ResizeBoxDto, { cpus }))).toEqual([])
  })

  it.each([0, -1, 0.124, 0.1251, 16.001, 17, NaN, Infinity, null])('rejects %s CPUs', async (cpus) => {
    expect(await validate(plainToInstance(ResizeBoxDto, { cpus }))).not.toEqual([])
  })

  it('keeps CPU optional for queries and memory-only growth', async () => {
    for (const request of [{}, { memory_mib: 2048 }]) {
      expect(await validate(plainToInstance(ResizeBoxDto, request))).toEqual([])
    }
  })
})
