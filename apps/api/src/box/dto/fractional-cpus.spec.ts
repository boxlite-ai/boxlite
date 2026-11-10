import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateBoxDto as RestCreate } from '../../boxlite-rest/dto/create-box.dto'
import { boxToBoxResponse, createBoxToCreateBox } from '../../boxlite-rest/mappers/box-to-box.mapper'
import { CreateBoxDto } from './create-box.dto'
import { ListBoxesQueryDto } from './list-boxes-query.dto'
import { assertWithinPerBoxLimits } from '../services/per-box-limits'
import { BoxState } from '../enums/box-state.enum'

const limits = { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }

describe('fractional CPU allocation boundaries', () => {
  it.each([0.01, 0.125, 0.5, 1, 1.001, 1.5, 2, 16])(
    'preserves %s through both DTOs and the response mapper',
    async (cpus) => {
      const rest = plainToInstance(RestCreate, { cpus })
      expect(await validate(rest)).toHaveLength(0)
      const internal = createBoxToCreateBox(rest)
      expect(await validate(internal)).toHaveLength(0)
      expect(internal.cpu).toBe(cpus)
      expect(() => assertWithinPerBoxLimits(cpus, 1, 1, limits)).not.toThrow()
      expect(boxToBoxResponse({ cpu: internal.cpu, state: BoxState.STARTED } as never).cpus).toBe(cpus)
    },
  )

  it.each([0, -1, 0.009, 0.1001, 16.001, 255, NaN, Infinity, -Infinity])(
    'rejects %s before persistence',
    async (cpu) => {
      expect((await validate(plainToInstance(RestCreate, { cpus: cpu }))).some((e) => e.property === 'cpus')).toBe(true)
      expect((await validate(plainToInstance(CreateBoxDto, { cpu }))).some((e) => e.property === 'cpu')).toBe(true)
      expect(() => assertWithinPerBoxLimits(cpu, 1, 1, limits)).toThrow()
    },
  )

  it('applies organization ceilings to fractional allocations', () => {
    expect(() => assertWithinPerBoxLimits(1.5, 1, 1, { ...limits, maxCpuPerBox: 1 })).toThrow(/per-box limit/)
  })

  it('allows fractional range filters', async () => {
    const query = plainToInstance(ListBoxesQueryDto, { minCpu: '0.01', maxCpu: '1.001' })
    expect(await validate(query)).toHaveLength(0)
    expect(query.minCpu).toBe(0.01)
    expect(query.maxCpu).toBe(1.001)
  })
})
