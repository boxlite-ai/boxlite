import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateVolumeDto } from './create-volume.dto'

describe('CreateVolumeDto name', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    return JSON.stringify(await validate(plainToInstance(CreateVolumeDto, payload)))
  }

  it('accepts an absent name', async () => {
    expect(await validate(plainToInstance(CreateVolumeDto, {}))).toHaveLength(0)
  })

  it('accepts names a -v source can express', async () => {
    for (const name of ['my-data', 'data_1', 'a.b', 'vol_01K2EXAMPLE', 'ab']) {
      expect(await validate(plainToInstance(CreateVolumeDto, { name }))).toHaveLength(0)
    }
  })

  // Each of these would be classified as a host path by the CLI's `-v` rule, or
  // would break the colon split, leaving the volume unmountable by name.
  it('rejects names that -v could never address', async () => {
    for (const name of ['./data', '/data', '~data', 'a/b', 'a:b', 'a b', '-data', '_data']) {
      expect(await errorsFor({ name })).toContain('matches')
    }
  })

  // A single character is indistinguishable from a Windows drive letter in any
  // `-v` parser, Docker's included.
  it('rejects a one-character name', async () => {
    expect(await errorsFor({ name: 'a' })).toContain('matches')
  })
})
