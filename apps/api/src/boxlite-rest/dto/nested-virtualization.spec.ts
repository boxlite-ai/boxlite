import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { CreateBoxDto } from './create-box.dto'
import { createBoxToCreateBox } from '../mappers/box-to-box.mapper'
import { requiresFreshBox } from '../../box/utils/warm-pool-eligibility.util'

describe('nested virtualization create contract', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  const parse = (advanced?: unknown) =>
    pipe.transform(
      { image: 'alpine:latest', ...(advanced === undefined ? {} : { advanced }) },
      {
        type: 'body',
        metatype: CreateBoxDto,
      },
    )

  it.each([undefined, false, true])('validates and forwards the choice %s', async (choice) => {
    const request = await parse(choice === undefined ? undefined : { nested_virtualization: choice })
    const mapped = createBoxToCreateBox(request) as unknown as Record<string, unknown>

    expect(mapped.nestedVirtualization).toBe(choice ?? false)
    expect(mapped.privileged).toBe(false)
    expect(requiresFreshBox(mapped as never, {}, { isOrgOwned: false })).toBe(choice === true)
  })

  it.each(['true', 'false', 0, 1, null, {}, []])('rejects a non-boolean choice %j', async (choice) => {
    await expect(parse({ nested_virtualization: choice })).rejects.toThrow()
  })
})
