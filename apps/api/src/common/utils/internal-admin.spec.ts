import { isInternalAdmin } from './internal-admin'

describe('isInternalAdmin', () => {
  const allow = ['dorian@polygala.ai', 'michael.li@polygala.ai', 'brianluo@polygala.ai']
  it('matches case-insensitively', () => {
    expect(isInternalAdmin('Dorian@Polygala.ai', allow)).toBe(true)
  })
  it('rejects a non-listed email', () => {
    expect(isInternalAdmin('stranger@polygala.ai', allow)).toBe(false)
  })
  it('handles undefined and empty allowlist', () => {
    expect(isInternalAdmin(undefined, allow)).toBe(false)
    expect(isInternalAdmin('a@b.com', [])).toBe(false)
  })
})
