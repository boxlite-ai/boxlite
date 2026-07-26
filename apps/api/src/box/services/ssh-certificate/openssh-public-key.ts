/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'crypto'
import { SshWireFormatError, SshWireReader, SshWireWriter } from './openssh-wire'
import { SshCertificateError } from './ssh-certificate.errors'

export const SSH_ED25519_ALGORITHM = 'ssh-ed25519'
export const ED25519_PUBLIC_KEY_BYTES = 32

/**
 * An `ssh-ed25519` authorized_keys line is ~80 characters. The cap only has to
 * reject payloads that are obviously not a single public key before any
 * base64 decoding happens.
 */
export const MAX_PUBLIC_KEY_INPUT_LENGTH = 1024

const OPENSSH_CERTIFICATE_SUFFIX = '-cert-v01@openssh.com'

export interface CanonicalSshPublicKey {
  algorithm: typeof SSH_ED25519_ALGORITHM
  /** RFC 4253 public key blob (base64-decoded). */
  blob: Buffer
  /** Raw 32-byte Ed25519 point, the `pk` field of an ssh-ed25519 certificate. */
  keyMaterial: Buffer
  /** `<algorithm> <base64(blob)>` with any comment stripped. */
  openssh: string
  /** `SHA256:<base64 of sha256(blob), unpadded>` - the fingerprint OpenSSH prints. */
  fingerprint: string
}

export function encodeEd25519PublicKeyBlob(keyMaterial: Buffer): Buffer {
  if (keyMaterial.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new SshWireFormatError(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`)
  }
  return new SshWireWriter().writeString(SSH_ED25519_ALGORITHM).writeString(keyMaterial).toBuffer()
}

export function sshPublicKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

export function formatOpenSshPublicKey(blob: Buffer, algorithm = SSH_ED25519_ALGORITHM): string {
  return `${algorithm} ${blob.toString('base64')}`
}

/**
 * Validates and canonicalizes untrusted client input at the API boundary.
 * Rejects malformed, oversized, non-Ed25519 keys and certificates presented as
 * public keys, each with its own stable error code.
 */
export function parseSshPublicKey(input: unknown): CanonicalSshPublicKey {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw SshCertificateError.publicKeyRequired()
  }

  const trimmed = input.trim()
  if (trimmed.length > MAX_PUBLIC_KEY_INPUT_LENGTH) {
    throw SshCertificateError.invalidPublicKey(
      `input exceeds ${MAX_PUBLIC_KEY_INPUT_LENGTH} characters and cannot be a single public key`,
    )
  }
  if (/[\r\n]/.test(trimmed)) {
    throw SshCertificateError.invalidPublicKey('input must be a single line')
  }

  const fields = trimmed.split(/\s+/)
  if (fields.length < 2) {
    throw SshCertificateError.invalidPublicKey('expected "<algorithm> <base64-key> [comment]"')
  }

  const [declaredAlgorithm, encodedBlob] = fields
  if (declaredAlgorithm.endsWith(OPENSSH_CERTIFICATE_SUFFIX)) {
    throw SshCertificateError.invalidPublicKey('an OpenSSH certificate is not a public key')
  }

  const blob = decodeBase64Strict(encodedBlob)
  const blobAlgorithm = readBlobAlgorithm(blob)
  if (blobAlgorithm !== declaredAlgorithm) {
    throw SshCertificateError.invalidPublicKey('algorithm prefix does not match the encoded key blob')
  }
  if (blobAlgorithm.endsWith(OPENSSH_CERTIFICATE_SUFFIX)) {
    throw SshCertificateError.invalidPublicKey('an OpenSSH certificate is not a public key')
  }
  if (blobAlgorithm !== SSH_ED25519_ALGORITHM) {
    throw SshCertificateError.unsupportedKeyAlgorithm(blobAlgorithm)
  }

  const keyMaterial = readEd25519KeyMaterial(blob)
  const canonicalBlob = encodeEd25519PublicKeyBlob(keyMaterial)
  return {
    algorithm: SSH_ED25519_ALGORITHM,
    blob: canonicalBlob,
    keyMaterial,
    openssh: formatOpenSshPublicKey(canonicalBlob),
    fingerprint: sshPublicKeyFingerprint(canonicalBlob),
  }
}

/**
 * Converts the DER SubjectPublicKeyInfo that AWS KMS `GetPublicKey` returns for
 * an `ECC_NIST_EDWARDS25519` key into an OpenSSH `ssh-ed25519` public key blob.
 *
 * Expected structure (RFC 8410):
 *   SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING (0 unused, 32 bytes) }
 */
export function ed25519SpkiToOpenSshBlob(der: Buffer): Buffer {
  const spki = readDerElement(der, 0x30, 'SubjectPublicKeyInfo')
  const algorithmIdentifier = readDerElement(spki.value, 0x30, 'AlgorithmIdentifier')
  const oid = readDerElement(algorithmIdentifier.value, 0x06, 'algorithm OID')
  if (!oid.value.equals(Buffer.from([0x2b, 0x65, 0x70]))) {
    throw new SshWireFormatError('SubjectPublicKeyInfo is not an Ed25519 (1.3.101.112) key')
  }

  const bitString = readDerElement(spki.value.subarray(algorithmIdentifier.totalLength), 0x03, 'subjectPublicKey')
  if (bitString.value.length !== ED25519_PUBLIC_KEY_BYTES + 1 || bitString.value[0] !== 0x00) {
    throw new SshWireFormatError('Ed25519 subjectPublicKey BIT STRING must hold 32 bytes with no unused bits')
  }

  return encodeEd25519PublicKeyBlob(Buffer.from(bitString.value.subarray(1)))
}

function decodeBase64Strict(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw SshCertificateError.invalidPublicKey('key body is not valid base64')
  }
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length === 0 || blob.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw SshCertificateError.invalidPublicKey('key body is not valid base64')
  }
  return blob
}

function readBlobAlgorithm(blob: Buffer): string {
  try {
    return new SshWireReader(blob).readUtf8String()
  } catch {
    throw SshCertificateError.invalidPublicKey('key blob is not a valid SSH wire encoding')
  }
}

function readEd25519KeyMaterial(blob: Buffer): Buffer {
  const reader = new SshWireReader(blob)
  let keyMaterial: Buffer
  try {
    reader.readUtf8String()
    keyMaterial = reader.readString()
  } catch {
    throw SshCertificateError.invalidPublicKey('key blob is not a valid SSH wire encoding')
  }
  if (keyMaterial.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw SshCertificateError.invalidPublicKey(`Ed25519 key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`)
  }
  if (reader.remaining !== 0) {
    throw SshCertificateError.invalidPublicKey('key blob has trailing bytes')
  }
  return Buffer.from(keyMaterial)
}

interface DerElement {
  value: Buffer
  totalLength: number
}

function readDerElement(buffer: Buffer, expectedTag: number, label: string): DerElement {
  if (buffer.length < 2 || buffer[0] !== expectedTag) {
    throw new SshWireFormatError(`DER ${label} has an unexpected tag`)
  }

  const first = buffer[1]
  let length: number
  let headerLength: number
  if (first < 0x80) {
    length = first
    headerLength = 2
  } else {
    const lengthBytes = first & 0x7f
    if (lengthBytes === 0 || lengthBytes > 2 || buffer.length < 2 + lengthBytes) {
      throw new SshWireFormatError(`DER ${label} has an unsupported length encoding`)
    }
    length = 0
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length << 8) | buffer[2 + index]
    }
    headerLength = 2 + lengthBytes
  }

  if (buffer.length < headerLength + length) {
    throw new SshWireFormatError(`DER ${label} is truncated`)
  }
  return { value: buffer.subarray(headerLength, headerLength + length), totalLength: headerLength + length }
}
