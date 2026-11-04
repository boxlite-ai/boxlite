import { ArgumentMetadata, ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { TypedConfigService } from '../config/typed-config.service'
import { CreateBoxDto } from './dto/create-box.dto'
import { BoxliteConfigController } from './boxlite-config.controller'
import { boxToBoxResponse, createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { BoxDto } from '../box/dto/box.dto'
import { Box } from '../box/entities/box.entity'

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
const metadata: ArgumentMetadata = { type: 'body', metatype: CreateBoxDto }

describe('Cloud nested virtualization public contract', () => {
  it.each([undefined, {}, { nested_virtualization: false }, { nested_virtualization: true }])(
    'validates and maps advanced=%j without authorizing other fields',
    async (advanced) => {
      const dto = await pipe.transform(
        { image: 'alpine:latest', ...(advanced === undefined ? {} : { advanced }) },
        metadata,
      )
      expect(createBoxToCreateBox(dto).nestedVirtualization).toBe(advanced?.nested_virtualization)
    },
  )

  it.each([null, 'true', 0, 1, [], {}])('rejects nested boolean %j', async (value) => {
    await expect(pipe.transform({ advanced: { nested_virtualization: value } }, metadata)).rejects.toThrow()
  })

  it.each([null, [], 'advanced', { capabilities: {} }, { capabilities: null }, { privileged: true }, { security: {} }])(
    'rejects unsupported or malformed advanced=%j',
    async (advanced) => {
      await expect(pipe.transform({ advanced }, metadata)).rejects.toThrow()
    },
  )

  it.each([undefined, null, false, true])('projects saved %j without reporting unknown as false', (saved) => {
    const box = new Box('test-region', 'nested-box')
    box.nestedVirtualization = saved
    const dto = BoxDto.fromBox(box, 'https://proxy.invalid')
    const response = JSON.parse(JSON.stringify(boxToBoxResponse(dto)))
    expect(response.advanced).toEqual(typeof saved === 'boolean' ? { nested_virtualization: saved } : undefined)
    expect(response.advanced && Object.keys(response.advanced)).toEqual(
      typeof saved === 'boolean' ? ['nested_virtualization'] : undefined,
    )
  })

  it.each([undefined, false, true])('advertises only the operator setting %j', (enabled) => {
    const config = new TypedConfigService(new ConfigService({ nestedVirtualizationEnabled: enabled }))
    const response = new BoxliteConfigController(config).getConfig()
    expect(response.capabilities.nested_virtualization_enabled).toBe(enabled === true)
  })
})
