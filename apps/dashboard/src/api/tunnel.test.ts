import { describe, expect, it } from 'vitest'
import { readTunnelDescriptor, tunnelOperationError, TunnelRequestError } from './tunnel'

describe('tunnel response and recovery safety', () => {
  it.each([
    null,
    undefined,
    4,
    'https://service.test',
    {},
    { uri: 'not a URL' },
    { uri: 'https://:secret@service.test', isPublic: true, token: null },
    { uri: 'https://service.test', isPublic: true, token: 'secret' },
  ])('rejects unusable or credential-bearing descriptors: %j', (value) => {
    expect(() => readTunnelDescriptor(value)).toThrow(TunnelRequestError)
    try {
      readTunnelDescriptor(value)
    } catch (error) {
      expect(error).toMatchObject({ outcome: 'unknown' })
      expect(JSON.stringify(error)).not.toContain('secret')
    }
  })
  it.each([
    [401, undefined, 'permission'],
    [403, undefined, 'permission'],
    [404, undefined, 'no longer available'],
    [409, 'inbound access disabled', 'Enable inbound'],
    [409, 'not running', 'Start this Box'],
    [409, undefined, 'current state'],
    [400, undefined, 'Check the port'],
  ])('gives an actionable refusal for HTTP %s / %s', (status, message, expected) => {
    const error = tunnelOperationError({ cause: { response: { status } }, message }, 'create')
    expect(error.outcome).toBe('refused')
    expect(error.message).toContain(expected)
  })
  it.each([undefined, null, new Error('network disconnected'), { response: { status: 503 } }])(
    'keeps a failed revocation retryable without claiming success: %j',
    (failure) => {
      expect(tunnelOperationError(failure, 'revoke')).toMatchObject({
        outcome: 'unknown',
        message: 'Could not confirm revocation. Retry revoking this port.',
      })
    },
  )
  it('preserves an already classified refusal', () => {
    const error = new TunnelRequestError('Private creation unavailable')
    expect(tunnelOperationError(error, 'create')).toBe(error)
  })
})
