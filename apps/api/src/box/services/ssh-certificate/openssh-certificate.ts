/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomBytes } from 'crypto'
import { SSH_ED25519_ALGORITHM } from './openssh-public-key'
import { SshWireFormatError, SshWireWriter } from './openssh-wire'

export const SSH_ED25519_CERTIFICATE_ALGORITHM = 'ssh-ed25519-cert-v01@openssh.com'
export const SSH_CERT_TYPE_USER = 1
export const ED25519_SIGNATURE_BYTES = 64
const CERTIFICATE_NONCE_BYTES = 32

/**
 * OpenSSH requires extension names to be lexically ordered. The guest supports
 * interactive shells and SFTP only, so no forwarding extensions are granted.
 */
export const USER_CERTIFICATE_EXTENSIONS: readonly string[] = ['permit-pty']

export interface OpenSshUserCertificateFields {
  /** Raw 32-byte Ed25519 point of the client key being certified. */
  clientKeyMaterial: Buffer
  serial: bigint
  keyId: string
  validPrincipals: readonly string[]
  validAfter: Date
  validBefore: Date
  /** RFC 4253 public key blob of the CA. */
  caPublicKeyBlob: Buffer
  /** Overridable only so tests can pin the nonce; production uses fresh randomness. */
  nonce?: Buffer
}

/**
 * Encodes everything an OpenSSH user certificate signs: the fields up to and
 * including `signature key`. The signature is appended by
 * {@link assembleOpenSshCertificate}.
 */
export function encodeUserCertificateTbs(fields: OpenSshUserCertificateFields): Buffer {
  if (fields.validPrincipals.length === 0) {
    throw new SshWireFormatError('an OpenSSH user certificate must carry at least one principal')
  }
  if (fields.validBefore.getTime() <= fields.validAfter.getTime()) {
    throw new SshWireFormatError('certificate validBefore must be after validAfter')
  }

  return new SshWireWriter()
    .writeString(SSH_ED25519_CERTIFICATE_ALGORITHM)
    .writeString(fields.nonce ?? randomBytes(CERTIFICATE_NONCE_BYTES))
    .writeString(fields.clientKeyMaterial)
    .writeUint64(fields.serial)
    .writeUint32(SSH_CERT_TYPE_USER)
    .writeString(fields.keyId)
    .writeStringSequence(fields.validPrincipals)
    .writeUint64(toUnixSeconds(fields.validAfter))
    .writeUint64(toUnixSeconds(fields.validBefore))
    .writeNameDataPairs([])
    .writeNameDataPairs(USER_CERTIFICATE_EXTENSIONS.map((name) => [name, ''] as const))
    .writeString('')
    .writeString(fields.caPublicKeyBlob)
    .toBuffer()
}

/** Wraps a raw 64-byte Ed25519 signature in the `ssh-ed25519` signature blob. */
export function encodeSshEd25519Signature(signature: Buffer): Buffer {
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new SshWireFormatError(`Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes`)
  }
  return new SshWireWriter().writeString(SSH_ED25519_ALGORITHM).writeString(signature).toBuffer()
}

/** Produces the single-line `<algorithm> <base64>` form OpenSSH clients read. */
export function assembleOpenSshCertificate(tbs: Buffer, signatureBlob: Buffer): string {
  const certificate = Buffer.concat([tbs, new SshWireWriter().writeString(signatureBlob).toBuffer()])
  return `${SSH_ED25519_CERTIFICATE_ALGORITHM} ${certificate.toString('base64')}`
}

function toUnixSeconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000))
}
