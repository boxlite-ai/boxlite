/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanonicalSshPublicKey } from './openssh-public-key'

export const SSH_CERTIFICATE_SIGNER = Symbol('SSH_CERTIFICATE_SIGNER')

/**
 * Everything a signer needs to mint one bounded, box-bound OpenSSH user
 * certificate. The service - not the adapter - owns identity, principals and
 * the validity window, so policy stays in one place.
 */
export interface SshCertificateSignRequest {
  organizationId: string
  boxId: string
  /** SSH login username the certificate authorizes. */
  loginUsername: string
  validPrincipals: readonly string[]
  /** OpenSSH `key id` field; the SSH access record ID. */
  keyId: string
  /** Unique-per-organization 64-bit certificate serial. */
  serial: bigint
  publicKey: CanonicalSshPublicKey
  validAfter: Date
  validBefore: Date
}

/** Non-secret result of a signing operation. Never carries private material. */
export interface SignedSshCertificate {
  /** `ssh-ed25519-cert-v01@openssh.com <base64>` */
  certificate: string
  /** Stable, non-secret CA key version that signed the certificate. */
  caKeyId: string
  serial: bigint
}

/**
 * Provider-neutral CA boundary. Implementations keep every provider SDK type,
 * credential and key reference behind this interface, and signal an unusable CA
 * by throwing `SshCertificateError.caUnavailable`.
 */
export interface SshCertificateSigner {
  /** Non-secret adapter identity used for logs and startup validation. */
  readonly providerName: string
  sign(request: SshCertificateSignRequest): Promise<SignedSshCertificate>
}
