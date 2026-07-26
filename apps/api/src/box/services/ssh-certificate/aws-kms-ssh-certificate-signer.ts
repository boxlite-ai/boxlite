/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  GetPublicKeyCommand,
  GetPublicKeyCommandOutput,
  KeySpec,
  KMSClient,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms'
import { OrganizationSshCaKey } from '../../entities/organization-ssh-ca-key.entity'
import {
  assembleOpenSshCertificate,
  ED25519_SIGNATURE_BYTES,
  encodeSshEd25519Signature,
  encodeUserCertificateTbs,
} from './openssh-certificate'
import { ed25519SpkiToOpenSshBlob, formatOpenSshPublicKey } from './openssh-public-key'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'
import { SignedSshCertificate, SshCertificateSignRequest, SshCertificateSigner } from './ssh-certificate-signer'
import { SshCertificateError } from './ssh-certificate.errors'

export const AWS_KMS_SSH_CERTIFICATE_SIGNER_PROVIDER = 'aws-kms'

export interface AwsKmsSshCertificateSignerOptions {
  region?: string
  endpoint?: string
}

/**
 * Signs OpenSSH user certificates with a non-exportable AWS KMS
 * `ECC_NIST_EDWARDS25519` key.
 *
 * Every AWS SDK type stays inside this file: the `SshCertificateSigner`
 * boundary carries only OpenSSH and BoxLite domain values.
 */
export class AwsKmsSshCertificateSigner implements SshCertificateSigner {
  readonly providerName = AWS_KMS_SSH_CERTIFICATE_SIGNER_PROVIDER

  private readonly kms: KMSClient
  /** Provider key reference -> OpenSSH CA public key blob, verified against the recorded key. */
  private readonly caPublicKeyBlobs = new Map<string, Buffer>()

  constructor(
    private readonly caKeys: OrganizationSshCaKeyService,
    options: AwsKmsSshCertificateSignerOptions = {},
    kmsClient?: KMSClient,
  ) {
    this.kms = kmsClient ?? new KMSClient({ region: options.region, endpoint: options.endpoint })
  }

  async sign(request: SshCertificateSignRequest): Promise<SignedSshCertificate> {
    const caKey = await this.caKeys.getCurrent(request.organizationId)
    const caPublicKeyBlob = await this.resolveCaPublicKeyBlob(caKey)

    const tbs = encodeUserCertificateTbs({
      clientKeyMaterial: request.publicKey.keyMaterial,
      serial: request.serial,
      keyId: request.keyId,
      validPrincipals: request.validPrincipals,
      validAfter: request.validAfter,
      validBefore: request.validBefore,
      caPublicKeyBlob,
    })

    const signature = await this.signRaw(caKey.providerKeyRef, tbs)
    return {
      certificate: assembleOpenSshCertificate(tbs, encodeSshEd25519Signature(signature)),
      caKeyId: caKey.keyId,
      serial: request.serial,
    }
  }

  /**
   * Fetches the DER SubjectPublicKeyInfo once per key reference, converts it to
   * the OpenSSH CA public key and pins it against the key recorded for the
   * organization. A mismatch means the trust delivered to guests does not match
   * the key we would sign with, so signing must not proceed.
   */
  private async resolveCaPublicKeyBlob(caKey: OrganizationSshCaKey): Promise<Buffer> {
    const cached = this.caPublicKeyBlobs.get(caKey.providerKeyRef)
    if (cached) {
      return cached
    }

    let response: GetPublicKeyCommandOutput
    try {
      response = await this.kms.send(new GetPublicKeyCommand({ KeyId: caKey.providerKeyRef }))
    } catch (error) {
      throw SshCertificateError.caUnavailable(`KMS GetPublicKey failed for CA key ${caKey.keyId}`, error)
    }

    const { KeySpec: keySpec, PublicKey: publicKey } = response
    if (keySpec !== KeySpec.ECC_NIST_EDWARDS25519) {
      throw SshCertificateError.caUnavailable(
        `CA key ${caKey.keyId} has key spec ${keySpec ?? 'unknown'}, expected ${KeySpec.ECC_NIST_EDWARDS25519}`,
      )
    }
    if (!publicKey) {
      throw SshCertificateError.caUnavailable(`KMS returned no public key for CA key ${caKey.keyId}`)
    }

    let blob: Buffer
    try {
      blob = ed25519SpkiToOpenSshBlob(Buffer.from(publicKey))
    } catch (error) {
      throw SshCertificateError.caUnavailable(`CA key ${caKey.keyId} public key is not a valid Ed25519 SPKI`, error)
    }

    if (formatOpenSshPublicKey(blob) !== caKey.publicKey.trim()) {
      throw SshCertificateError.caUnavailable(`CA key ${caKey.keyId} does not match the recorded CA public key`)
    }

    this.caPublicKeyBlobs.set(caKey.providerKeyRef, blob)
    return blob
  }

  private async signRaw(providerKeyRef: string, message: Buffer): Promise<Buffer> {
    let signature: Uint8Array | undefined
    try {
      const response = await this.kms.send(
        new SignCommand({
          KeyId: providerKeyRef,
          Message: message,
          MessageType: MessageType.RAW,
          SigningAlgorithm: SigningAlgorithmSpec.ED25519_SHA_512,
        }),
      )
      signature = response.Signature
    } catch (error) {
      throw SshCertificateError.caUnavailable('KMS Sign failed', error)
    }

    if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) {
      throw SshCertificateError.caUnavailable(
        `KMS returned a ${signature?.length ?? 0}-byte signature, expected ${ED25519_SIGNATURE_BYTES}`,
      )
    }
    return Buffer.from(signature)
  }
}
