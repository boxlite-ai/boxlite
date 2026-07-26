/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TypedConfigService } from '../../../config/typed-config.service'
import { AwsKmsSshCertificateSigner } from './aws-kms-ssh-certificate-signer'
import { LocalSshCertificateSigner } from './local-ssh-certificate-signer'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'
import { createSshCertificateSigner } from './ssh-certificate-signer.provider'

function configStub(values: Record<string, unknown>): TypedConfigService {
  return { get: (key: string) => values[key] } as unknown as TypedConfigService
}

const caKeys = {} as OrganizationSshCaKeyService

describe('createSshCertificateSigner', () => {
  it('refuses the in-process test CA in production', () => {
    const configService = configStub({ 'sshCertificate.signerProvider': 'local', production: true })

    expect(() => createSshCertificateSigner(configService, caKeys)).toThrow(/test-only in-process CA/)
  })

  it('allows the in-process test CA outside production', () => {
    const configService = configStub({ 'sshCertificate.signerProvider': 'local', production: false })

    expect(createSshCertificateSigner(configService, caKeys)).toBeInstanceOf(LocalSshCertificateSigner)
  })

  it('builds the AWS KMS adapter for the default provider', () => {
    const configService = configStub({
      'sshCertificate.signerProvider': 'aws-kms',
      'sshCertificate.aws.region': 'us-east-1',
      'sshCertificate.aws.kmsEndpoint': undefined,
      production: true,
    })

    const signer = createSshCertificateSigner(configService, caKeys)

    expect(signer).toBeInstanceOf(AwsKmsSshCertificateSigner)
    expect(signer.providerName).toBe('aws-kms')
  })

  it('rejects an unknown provider name', () => {
    const configService = configStub({ 'sshCertificate.signerProvider': 'vault', production: false })

    expect(() => createSshCertificateSigner(configService, caKeys)).toThrow(
      /Unknown SSH_CERTIFICATE_SIGNER_PROVIDER "vault"/,
    )
  })
})

describe('sshCertificate configuration defaults', () => {
  it('leaves issuance disabled and the signer on AWS KMS when nothing is configured', () => {
    const previousEnv = { ...process.env }
    delete process.env.SSH_CERTIFICATE_ISSUANCE_ENABLED
    delete process.env.SSH_CERTIFICATE_SIGNER_PROVIDER
    jest.resetModules()

    const { configuration } = require('../../../config/configuration')

    expect(configuration.sshCertificate.issuanceEnabled).toBe(false)
    expect(configuration.sshCertificate.signerProvider).toBe('aws-kms')
    expect(configuration.sshCertificate.defaultTtlMinutes).toBe(5)
    expect(configuration.sshCertificate.minTtlMinutes).toBe(1)
    expect(configuration.sshCertificate.maxTtlMinutes).toBe(60)
    expect(configuration.sshCertificate.clockSkewSeconds).toBe(30)

    process.env = previousEnv
  })
})
