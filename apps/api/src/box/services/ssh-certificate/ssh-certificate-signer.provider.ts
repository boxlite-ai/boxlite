/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Provider } from '@nestjs/common'
import { TypedConfigService } from '../../../config/typed-config.service'
import {
  AWS_KMS_SSH_CERTIFICATE_SIGNER_PROVIDER,
  AwsKmsSshCertificateSigner,
} from './aws-kms-ssh-certificate-signer'
import { LOCAL_SSH_CERTIFICATE_SIGNER_PROVIDER, LocalSshCertificateSigner } from './local-ssh-certificate-signer'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'
import { SSH_CERTIFICATE_SIGNER, SshCertificateSigner } from './ssh-certificate-signer'

/**
 * Resolves the configured CA signer at startup so an unusable configuration
 * fails the bootstrap instead of the first issuance request.
 *
 * @throws Error when a production deployment selects the in-process test CA, or
 * when the provider name is unknown.
 */
export function createSshCertificateSigner(
  configService: TypedConfigService,
  caKeys: OrganizationSshCaKeyService,
): SshCertificateSigner {
  const provider = configService.get('sshCertificate.signerProvider')

  if (provider === LOCAL_SSH_CERTIFICATE_SIGNER_PROVIDER) {
    if (configService.get('production')) {
      throw new Error(
        `SSH_CERTIFICATE_SIGNER_PROVIDER="${LOCAL_SSH_CERTIFICATE_SIGNER_PROVIDER}" is a test-only in-process CA and cannot be used in production`,
      )
    }
    return LocalSshCertificateSigner.generate()
  }

  if (provider === AWS_KMS_SSH_CERTIFICATE_SIGNER_PROVIDER) {
    return new AwsKmsSshCertificateSigner(caKeys, {
      region: configService.get('sshCertificate.aws.region'),
      endpoint: configService.get('sshCertificate.aws.kmsEndpoint'),
    })
  }

  throw new Error(`Unknown SSH_CERTIFICATE_SIGNER_PROVIDER "${provider}"`)
}

export const sshCertificateSignerProvider: Provider = {
  provide: SSH_CERTIFICATE_SIGNER,
  inject: [TypedConfigService, OrganizationSshCaKeyService],
  useFactory: createSshCertificateSigner,
}
