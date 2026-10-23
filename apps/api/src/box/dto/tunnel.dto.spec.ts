import { validate } from 'class-validator'
import { PrepareTunnelDto, TunnelAccessDto } from './tunnel.dto'

describe('Tunnel request validation', () => {
  it.each([null, 'false', 0, {}])('rejects a non-boolean access mode: %p', async (isPublic) => {
    expect(await validate(Object.assign(new PrepareTunnelDto(), { isPublic }))).not.toHaveLength(0)
  })
  it.each([true, false, undefined])('accepts a boolean or omitted access mode: %p', async (isPublic) => {
    expect(await validate(Object.assign(new PrepareTunnelDto(), { isPublic }))).toHaveLength(0)
  })
  it('rejects null and oversized token credentials before hashing', async () => {
    for (const token of [null, 'x'.repeat(257)]) {
      expect(await validate(Object.assign(new TunnelAccessDto(), { token }))).not.toHaveLength(0)
    }
  })
})
