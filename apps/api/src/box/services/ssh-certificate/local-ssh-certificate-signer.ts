/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { generateKeyPairSync, KeyObject, sign as signWithKey } from 'crypto'
import {
  assembleOpenSshCertificate,
  encodeSshEd25519Signature,
  encodeUserCertificateTbs,
} from './openssh-certificate'
import { ed25519SpkiToOpenSshBlob, formatOpenSshPublicKey } from './openssh-public-key'
import { SignedSshCertificate, SshCertificateSignRequest, SshCertificateSigner } from './ssh-certificate-signer'

export const LOCAL_SSH_CERTIFICATE_SIGNER_PROVIDER = 'local'

/**
 * In-process Ed25519 CA for unit, integration and interoperability tests.
 *
 * Selecting this provider in a production configuration fails startup
 * validation (see `createSshCertificateSigner`): the CA private key would live
 * in application memory, which is exactly what the signer boundary exists to
 * prevent.
 */
export class LocalSshCertificateSigner implements SshCertificateSigner {
  readonly providerName = LOCAL_SSH_CERTIFICATE_SIGNER_PROVIDER
  readonly caPublicKeyBlob: Buffer

  private constructor(
    readonly caKeyId: string,
    private readonly caPrivateKey: KeyObject,
    caPublicKey: KeyObject,
  ) {
    // Exercises the same DER SPKI conversion the KMS adapter uses, so the
    // interoperability tests cover the production conversion path.
    this.caPublicKeyBlob = ed25519SpkiToOpenSshBlob(caPublicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  }

  static generate(caKeyId = 'local-test-ca'): LocalSshCertificateSigner {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    return new LocalSshCertificateSigner(caKeyId, privateKey, publicKey)
  }

  get caPublicKeyOpenssh(): string {
    return formatOpenSshPublicKey(this.caPublicKeyBlob)
  }

  async sign(request: SshCertificateSignRequest): Promise<SignedSshCertificate> {
    const tbs = encodeUserCertificateTbs({
      clientKeyMaterial: request.publicKey.keyMaterial,
      serial: request.serial,
      keyId: request.keyId,
      validPrincipals: request.validPrincipals,
      validAfter: request.validAfter,
      validBefore: request.validBefore,
      caPublicKeyBlob: this.caPublicKeyBlob,
    })

    const signature = signWithKey(null, tbs, this.caPrivateKey)
    return {
      certificate: assembleOpenSshCertificate(tbs, encodeSshEd25519Signature(signature)),
      caKeyId: this.caKeyId,
      serial: request.serial,
    }
  }
}
