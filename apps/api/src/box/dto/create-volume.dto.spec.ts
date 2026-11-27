import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateVolumeDto, FILESTORE_INSTANCE_PATTERN } from './create-volume.dto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

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

// The instance name becomes a component of the runner's host mount path
// (/mnt/boxlite-filestore-<name>), so the API configuration grammar must keep
// out path separators and relative components, and stay free of characters a
// `-v` source could never address.
describe('CreateVolumeDto filestore instance', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    return JSON.stringify(await validate(plainToInstance(CreateVolumeDto, payload)))
  }

  it('accepts an absent instance (object-storage kind)', async () => {
    expect(await validate(plainToInstance(CreateVolumeDto, {}))).toHaveLength(0)
  })

  it('validates names matching the runner path-safety grammar', async () => {
    for (const instance of ['ml-scratch', 'a', 'vol-1']) {
      expect(await validate(plainToInstance(CreateVolumeDto, { instance }))).toHaveLength(0)
      expect(await validate(plainToInstance(CreateVolumeDto, { storageBackend: 'performance', instance }))).toHaveLength(
        0,
      )
    }
  })

  it.each(['ML', '-x', 'a/b', 'a:b', ''])(
    'rejects a Filestore instance outside the path-safety grammar (%s)',
    async (instance) => {
      expect(await errorsFor({ storageBackend: 'performance', instance })).toContain('matches')
    },
  )

  it('rejects an unsupported backend', async () => {
    expect(await errorsFor({ storageBackend: 'unknown' })).toContain('storageBackend')
  })
})

describe('CreateVolumeDto OpenAPI contract', () => {
  it('uses the server-side Filestore instance grammar in the public schema', () => {
    const document = parse(readFileSync(path.resolve(__dirname, '../../../../../openapi/box.openapi.yaml'), 'utf8'))
    const pattern = document.components.schemas.CreateVolumeRequest.properties.instance.pattern

    expect(pattern).toBe(FILESTORE_INSTANCE_PATTERN.source)
    for (const instance of ['1foo', 'foo-']) {
      expect(new RegExp(pattern).test(instance)).toBe(false)
    }
  })
})
