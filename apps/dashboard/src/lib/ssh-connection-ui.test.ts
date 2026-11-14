import { describe, expect, it } from 'vitest'
import { BoxliteError } from '@/api/errors'
import { sshFailureReason } from './ssh-connection-ui'

describe('sshFailureReason', () => {
  it.each([
    [401, 'authentication'],
    [403, 'permission'],
  ] as const)('preserves HTTP %i as %s after API error normalization', (statusCode, expected) => {
    expect(sshFailureReason(BoxliteError.fromString('request failed', { statusCode }))).toBe(expected)
  })

  it('still recognizes a missing configuration after API error normalization', () => {
    const error = BoxliteError.fromString('SSH configuration is required', { statusCode: 400 })
    expect(sshFailureReason(error)).toBe('missing-config')
  })
})
