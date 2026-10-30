import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { PIPES_METADATA } from '@nestjs/common/constants'
import { BoxliteResizeController } from './boxlite-resize.controller'
import { ResizeBoxDto } from './dto/resize-box.dto'

describe('Cloud resize request contract', () => {
  const pipe: ValidationPipe = Reflect.getMetadata(PIPES_METADATA, BoxliteResizeController).find(
    (value: unknown) => value instanceof ValidationPipe,
  )
  const meta = { type: 'body' as const, metatype: ResizeBoxDto }

  it.each([
    { cpus: 0 },
    { cpus: 256 },
    { cpus: 1.5 },
    { cpus: '4' },
    { cpus: null },
    { memory_mib: 0 },
    { memory_mib: null },
    { memory_mib: 0x100000000 },
    { max_cpus: 16 },
    { disk: 20 },
  ])('rejects invalid or undeclared fields %j', async (body) => {
    await expect(pipe.transform(body, meta)).rejects.toThrow()
  })

  it.each([{}, { cpus: 4 }, { memory_mib: 1537 }, { cpus: 4, memory_mib: 2048 }])(
    'accepts query and partial targets %j',
    async (body) => {
      expect(await pipe.transform(body, meta)).toEqual(body)
    },
  )
})
