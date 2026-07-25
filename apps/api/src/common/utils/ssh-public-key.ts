/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'crypto'

// Matches the guest's `is_supported_algorithm`
// (src/guest/src/service/ssh/access.rs): Ed25519 and RSA, rejecting DSA and
// anything unrecognized. The guest additionally restricts RSA to
// RSA-SHA2 signatures at the protocol/handshake layer -- that is not
// decidable from a bare public-key line, so this parser only rejects what
// the key blob itself can tell us (algorithm label, size, RSA modulus bits).
const SUPPORTED_ALGORITHMS = new Set(['ssh-ed25519', 'ssh-rsa'])
const MIN_RSA_MODULUS_BITS = 2048
const MAX_LINE_BYTES = 8192

export interface ParsedSshPublicKey {
  algorithm: string
  fingerprint: string
  canonicalLine: string
}

export class SshPublicKeyError extends Error {}

// Parses and validates a canonical OpenSSH public-key line (e.g.
// `"ssh-ed25519 AAAA... comment"`), rejecting oversized input, malformed
// wire-format blobs, and unsupported algorithms. Returns the SHA-256
// fingerprint (`SHA256:...`) and a canonical `<algorithm> <base64>` line
// (comment stripped) -- never logs or returns the raw key bytes beyond what
// the caller already supplied.
export function parseSshPublicKey(line: string): ParsedSshPublicKey {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LINE_BYTES) {
    throw new SshPublicKeyError('public key line is empty or exceeds the size limit')
  }

  const [label, base64Blob] = trimmed.split(/\s+/)
  if (!label || !base64Blob) {
    throw new SshPublicKeyError('malformed public key: expected "<algorithm> <base64> [comment]"')
  }

  const blob = decodeBase64Strict(base64Blob)
  const reader = new SshWireReader(blob)
  const embeddedAlgorithm = reader.readBytes().toString('ascii')
  if (embeddedAlgorithm !== label) {
    throw new SshPublicKeyError(
      `malformed public key: label "${label}" does not match embedded algorithm "${embeddedAlgorithm}"`,
    )
  }
  if (!SUPPORTED_ALGORITHMS.has(embeddedAlgorithm)) {
    throw new SshPublicKeyError(`unsupported key algorithm: ${embeddedAlgorithm}`)
  }

  if (embeddedAlgorithm === 'ssh-rsa') {
    reader.readBytes() // public exponent `e` -- not size-checked, RSA security comes from the modulus
    const modulus = reader.readBytes()
    const modulusBits = effectiveBitLength(modulus)
    if (modulusBits < MIN_RSA_MODULUS_BITS) {
      throw new SshPublicKeyError(`RSA key too small: ${modulusBits} bits (minimum ${MIN_RSA_MODULUS_BITS})`)
    }
  } else {
    const point = reader.readBytes()
    if (point.length !== 32) {
      throw new SshPublicKeyError(`malformed ed25519 public key: expected 32 bytes, got ${point.length}`)
    }
  }

  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
  return {
    algorithm: embeddedAlgorithm,
    fingerprint,
    canonicalLine: `${label} ${base64Blob}`,
  }
}

function decodeBase64Strict(base64: string): Buffer {
  const blob = Buffer.from(base64, 'base64')
  // Buffer.from silently drops invalid characters instead of throwing; a
  // round-trip re-encode is the standard way to catch that.
  if (blob.length === 0 || blob.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new SshPublicKeyError('malformed public key: invalid base64')
  }
  return blob
}

// Strips leading all-zero bytes (two's-complement sign padding, standard in
// SSH-wire-format RSA moduli) before counting significant bits.
function effectiveBitLength(modulus: Buffer): number {
  let start = 0
  while (start < modulus.length - 1 && modulus[start] === 0) {
    start++
  }
  const significant = modulus.subarray(start)
  if (significant.length === 0) {
    return 0
  }
  const leadingBits = 32 - Math.clz32(significant[0])
  return (significant.length - 1) * 8 + leadingBits
}

// Minimal reader for the SSH binary wire format (RFC 4251 §5): each field is
// a 4-byte big-endian length prefix followed by that many bytes.
class SshWireReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  readBytes(): Buffer {
    if (this.offset + 4 > this.buffer.length) {
      throw new SshPublicKeyError('malformed public key: truncated length prefix')
    }
    const length = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    if (length > this.buffer.length - this.offset) {
      throw new SshPublicKeyError('malformed public key: truncated field')
    }
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
}
