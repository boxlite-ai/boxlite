/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { parseSshPublicKey, SshPublicKeyError } from './ssh-public-key'

function lengthPrefixed(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([length, bytes])
}

function ed25519Line(pointLength = 32, comment = 'user@host'): string {
  const blob = Buffer.concat([
    lengthPrefixed(Buffer.from('ssh-ed25519')),
    lengthPrefixed(Buffer.alloc(pointLength, 0x11)),
  ])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

function rsaLine(modulusBits: number): string {
  const modulusBytes = Math.ceil(modulusBits / 8)
  const modulus = Buffer.alloc(modulusBytes, 0xff)
  // Force the top byte to have exactly `modulusBits % 8 || 8` significant
  // bits so the fixture's advertised size matches what effectiveBitLength
  // will compute.
  const topBits = modulusBits % 8 || 8
  modulus[0] = 0xff >> (8 - topBits)
  const blob = Buffer.concat([
    lengthPrefixed(Buffer.from('ssh-rsa')),
    lengthPrefixed(Buffer.from([0x01, 0x00, 0x01])), // e = 65537
    lengthPrefixed(modulus),
  ])
  return `ssh-rsa ${blob.toString('base64')} user@host`
}

describe('parseSshPublicKey', () => {
  it('accepts a well-formed ed25519 key and computes a stable fingerprint', () => {
    const line = ed25519Line()
    const parsed = parseSshPublicKey(line)
    expect(parsed.algorithm).toBe('ssh-ed25519')
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(parseSshPublicKey(line).fingerprint).toBe(parsed.fingerprint)
  })

  it('strips the comment from the canonical line', () => {
    const parsed = parseSshPublicKey(ed25519Line(32, 'alice@laptop some extra words'))
    expect(parsed.canonicalLine.split(' ')).toHaveLength(2)
  })

  it('rejects an ed25519 key with the wrong point length', () => {
    expect(() => parseSshPublicKey(ed25519Line(16))).toThrow(SshPublicKeyError)
  })

  it('accepts a 2048-bit RSA key', () => {
    const parsed = parseSshPublicKey(rsaLine(2048))
    expect(parsed.algorithm).toBe('ssh-rsa')
  })

  it('rejects an RSA key below the minimum modulus size', () => {
    expect(() => parseSshPublicKey(rsaLine(1024))).toThrow(/too small/)
  })

  it('rejects ssh-dss', () => {
    const blob = Buffer.concat([lengthPrefixed(Buffer.from('ssh-dss')), lengthPrefixed(Buffer.alloc(8))])
    expect(() => parseSshPublicKey(`ssh-dss ${blob.toString('base64')}`)).toThrow(/unsupported key algorithm/)
  })

  it('rejects a label that does not match the embedded algorithm', () => {
    const blob = Buffer.concat([lengthPrefixed(Buffer.from('ssh-ed25519')), lengthPrefixed(Buffer.alloc(32))])
    expect(() => parseSshPublicKey(`ssh-rsa ${blob.toString('base64')}`)).toThrow(/does not match embedded/)
  })

  it('rejects malformed base64', () => {
    expect(() => parseSshPublicKey('ssh-ed25519 not-valid-base64!!! comment')).toThrow(SshPublicKeyError)
  })

  it('rejects truncated wire-format data', () => {
    const truncated = Buffer.from('ssh-ed25519').toString('base64')
    expect(() => parseSshPublicKey(`ssh-ed25519 ${truncated}`)).toThrow(/truncated/)
  })

  it('rejects an empty or oversized line', () => {
    expect(() => parseSshPublicKey('')).toThrow(SshPublicKeyError)
    expect(() => parseSshPublicKey(`ssh-ed25519 ${'A'.repeat(9000)}`)).toThrow(SshPublicKeyError)
  })

  it('rejects a single-token line with no key material', () => {
    expect(() => parseSshPublicKey('ssh-ed25519')).toThrow(/expected/)
  })
})
