/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { normalizeCustomHostname } from './custom-domain-policy'

describe('custom domain admission syntax', () => {
  it.each(['app.example.com', 'App.Example.COM.', ' app.example.com '])('normalizes %s', (name) => {
    expect(normalizeCustomHostname(name, [])).toBe('app.example.com')
  })
  it.each([
    'example.com',
    'example.co.uk',
    'github.io',
    'customer.github.io',
    'localhost',
    'a.invalid',
    '*.example.com',
    'https://app.example.com',
    'app.example.com:443',
    '127.0.0.1',
    'é.example.com',
    'a..example.com',
    null,
  ])('rejects %s', (name) => {
    expect(() => normalizeCustomHostname(name, [])).toThrow()
  })
  it('respects the public/private suffix boundaries', () => {
    expect(normalizeCustomHostname('app.customer.co.uk', [])).toBe('app.customer.co.uk')
    expect(normalizeCustomHostname('app.customer.github.io', [])).toBe('app.customer.github.io')
  })
  it('rejects full reserved suffix boundaries, including nested platform names', () => {
    for (const name of ['apps.example.com', 'one.apps.example.com', 'a.b.apps.example.com']) {
      expect(() => normalizeCustomHostname(name, ['apps.example.com'])).toThrow('reserved')
    }
    expect(normalizeCustomHostname('notapps.example.com', ['apps.example.com'])).toBe('notapps.example.com')
    expect(normalizeCustomHostname('apps.example.com.evil.com', ['apps.example.com'])).toBe('apps.example.com.evil.com')
  })
  it('applies the GCP 220-byte boundary', () => {
    const prefix = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63)].join('.')
    const accepted = `${prefix}.${'d'.repeat(16)}.example.com`
    expect(accepted).toHaveLength(220)
    expect(normalizeCustomHostname(accepted, [])).toBe(accepted)
    expect(() => normalizeCustomHostname(`x${accepted}`, [])).toThrow()
  })
})
