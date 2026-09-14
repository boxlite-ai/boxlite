import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import {
  BatchDeleteVolumeFilesDto,
  ListVolumeFilesQueryDto,
  PresignBatchWriteVolumeFilesDto,
  VolumeFilePathQueryDto,
} from './volume-file.dto'

describe.each([
  ['BatchDeleteVolumeFilesDto', BatchDeleteVolumeFilesDto],
  ['PresignBatchWriteVolumeFilesDto', PresignBatchWriteVolumeFilesDto],
])('%s.paths validation', (_name, DtoClass) => {
  it('accepts a non-empty array within the size cap', async () => {
    const dto = plainToInstance(DtoClass, { paths: ['a.txt', 'b.txt'] })
    expect(await validate(dto)).toHaveLength(0)
  })

  it('accepts exactly 1000 paths (the cap boundary)', async () => {
    const dto = plainToInstance(DtoClass, { paths: Array.from({ length: 1000 }, (_, i) => `f${i}.txt`) })
    expect(await validate(dto)).toHaveLength(0)
  })

  it('rejects an empty array', async () => {
    const dto = plainToInstance(DtoClass, { paths: [] })
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && 'arrayNotEmpty' in e.constraints)).toBe(true)
  })

  it('rejects more than 1000 paths', async () => {
    const dto = plainToInstance(DtoClass, { paths: Array.from({ length: 1001 }, (_, i) => `f${i}.txt`) })
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && 'arrayMaxSize' in e.constraints)).toBe(true)
  })
})

// A raw `@Query('path')` accepts whatever Express hands it, including an
// array from a repeated key (`?path=a&path=b`) or explicit array syntax
// (`?path[]=a`) - CodeQL flagged the resulting type confusion once that
// value reaches a string-only operation downstream. These DTOs are the
// fix: `@IsString()`, enforced by the app's global ValidationPipe, rejects
// an array with 400 before the controller method ever runs.
describe('VolumeFilePathQueryDto', () => {
  it('accepts a plain string path', async () => {
    const dto = plainToInstance(VolumeFilePathQueryDto, { path: 'a.txt' })
    expect(await validate(dto)).toHaveLength(0)
  })

  it('rejects an array value (repeated query key or array syntax)', async () => {
    const dto = plainToInstance(VolumeFilePathQueryDto, { path: ['a.txt', 'b.txt'] })
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && 'isString' in e.constraints)).toBe(true)
  })

  it('rejects a missing path', async () => {
    const dto = plainToInstance(VolumeFilePathQueryDto, {})
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && ('isString' in e.constraints || 'isNotEmpty' in e.constraints))).toBe(
      true,
    )
  })
})

describe('ListVolumeFilesQueryDto', () => {
  it('accepts both fields omitted (list the volume root, no cursor)', async () => {
    const dto = plainToInstance(ListVolumeFilesQueryDto, {})
    expect(await validate(dto)).toHaveLength(0)
  })

  it('rejects an array value for path', async () => {
    const dto = plainToInstance(ListVolumeFilesQueryDto, { path: ['a/', 'b/'] })
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && 'isString' in e.constraints)).toBe(true)
  })

  it('rejects an array value for cursor', async () => {
    const dto = plainToInstance(ListVolumeFilesQueryDto, { cursor: ['x', 'y'] })
    const errors = await validate(dto)
    expect(errors.some((e) => e.constraints && 'isString' in e.constraints)).toBe(true)
  })
})
