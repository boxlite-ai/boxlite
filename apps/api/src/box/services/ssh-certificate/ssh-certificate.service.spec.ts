/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Repository } from 'typeorm'
import { TypedConfigService } from '../../../config/typed-config.service'
import { SshCertificateCredential } from '../../entities/ssh-certificate-credential.entity'
import { LocalSshCertificateSigner } from './local-ssh-certificate-signer'
import { parseSshPublicKey } from './openssh-public-key'
import { SshCertificateSigner } from './ssh-certificate-signer'
import { SshCertificateError, SshCertificateErrorCode } from './ssh-certificate.errors'
import { SshCertificateService } from './ssh-certificate.service'

const BOX_ID = 'box-01hzzzzzzzzzzzzzzzzzzzzzzz'
const ORGANIZATION_ID = '11111111-2222-3333-4444-555555555555'
const CLIENT_PUBLIC_KEY = LocalSshCertificateSigner.generate().caPublicKeyOpenssh

const DEFAULT_CONFIG: Record<string, unknown> = {
  'sshCertificate.issuanceEnabled': true,
  'sshCertificate.defaultTtlMinutes': 5,
  'sshCertificate.minTtlMinutes': 1,
  'sshCertificate.maxTtlMinutes': 60,
  'sshCertificate.clockSkewSeconds': 30,
  'sshCertificate.maxActiveCredentialsPerBox': 10,
  'sshCertificate.issueRateLimit': { limit: 10, windowSeconds: 60 },
}

/** Minimal in-memory stand-in for the credential repository. */
class CredentialRepositoryStub {
  readonly rows: SshCertificateCredential[] = []
  saveError?: Error

  create(input: Partial<SshCertificateCredential>): SshCertificateCredential {
    return { ...input } as SshCertificateCredential
  }

  async save(credential: SshCertificateCredential): Promise<SshCertificateCredential> {
    if (this.saveError) {
      throw this.saveError
    }
    const existing = this.rows.findIndex((row) => row.id === credential.id)
    if (existing >= 0) {
      this.rows[existing] = credential
    } else {
      this.rows.push({ ...credential, createdAt: new Date(), updatedAt: new Date() })
    }
    return credential
  }

  async count(options: { where: Record<string, unknown> }): Promise<number> {
    return this.rows.filter((row) => matches(row, options.where)).length
  }

  async find(options: { where: Record<string, unknown> }): Promise<SshCertificateCredential[]> {
    return this.rows.filter((row) => matches(row, options.where))
  }

  async findOne(options: { where: Record<string, unknown> }): Promise<SshCertificateCredential | null> {
    return this.rows.find((row) => matches(row, options.where)) ?? null
  }
}

function matches(row: SshCertificateCredential, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = (row as unknown as Record<string, unknown>)[field]
    if (condition && typeof condition === 'object' && 'type' in (condition as Record<string, unknown>)) {
      const findOperator = condition as { type: string; value: unknown }
      if (findOperator.type === 'isNull') {
        return value === null || value === undefined
      }
      if (findOperator.type === 'moreThan') {
        return (value as Date) > (findOperator.value as Date)
      }
      throw new Error(`unsupported operator ${findOperator.type}`)
    }
    return value === condition
  })
}

function buildService(overrides: Partial<Record<string, unknown>> = {}, signer?: SshCertificateSigner) {
  const repository = new CredentialRepositoryStub()
  const values = { ...DEFAULT_CONFIG, ...overrides }
  const configService = { get: (key: string) => values[key] } as unknown as TypedConfigService
  const service = new SshCertificateService(
    repository as unknown as Repository<SshCertificateCredential>,
    signer ?? LocalSshCertificateSigner.generate('test-ca-v1'),
    configService,
  )
  return { service, repository }
}

function issueCommand(overrides: Partial<Parameters<SshCertificateService['issue']>[0]> = {}) {
  return { boxId: BOX_ID, organizationId: ORGANIZATION_ID, publicKey: CLIENT_PUBLIC_KEY, ...overrides }
}

describe('SshCertificateService.issue', () => {
  it('is disabled by default and refuses to issue', async () => {
    const { service, repository } = buildService({ 'sshCertificate.issuanceEnabled': false })

    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CERTIFICATE_ISSUANCE_DISABLED,
    })
    expect(repository.rows).toHaveLength(0)
  })

  it('persists public material only, with the credential ID as the certificate key ID', async () => {
    const { service, repository } = buildService()

    const credential = await service.issue(issueCommand())

    expect(repository.rows).toHaveLength(1)
    expect(credential.certificate.startsWith('ssh-ed25519-cert-v01@openssh.com ')).toBe(true)
    expect(credential.publicKey).toBe(parseSshPublicKey(CLIENT_PUBLIC_KEY).openssh)
    expect(credential.fingerprint).toBe(parseSshPublicKey(CLIENT_PUBLIC_KEY).fingerprint)
    expect(credential.caKeyId).toBe('test-ca-v1')
    expect(BigInt(credential.serial) > 0n).toBe(true)
    expect(credential.revokedAt).toBeNull()
    expect(Object.keys(credential)).not.toContain('privateKey')
  })

  it('backdates validAfter by the configured clock skew and honours the default TTL', async () => {
    const { service } = buildService()

    const credential = await service.issue(issueCommand())

    const ttlMs = credential.expiresAt.getTime() - credential.validAfter.getTime()
    expect(ttlMs).toBe(5 * 60 * 1000 + 30 * 1000)
  })

  it('signs the exact principal set root, box:<id> and org:<id>', async () => {
    const signer = LocalSshCertificateSigner.generate()
    const sign = jest.spyOn(signer, 'sign')
    const { service } = buildService({}, signer)

    await service.issue(issueCommand())

    expect(sign.mock.calls[0][0].validPrincipals).toEqual([
      'root',
      `box:${BOX_ID}`,
      `org:${ORGANIZATION_ID}`,
    ])
    expect(sign.mock.calls[0][0].loginUsername).toBe('root')
  })

  it('does not revoke or touch existing credentials', async () => {
    const { service, repository } = buildService()

    const first = await service.issue(issueCommand())
    const second = await service.issue(issueCommand())

    expect(repository.rows).toHaveLength(2)
    expect(first.id).not.toBe(second.id)
    expect(repository.rows.every((row) => row.revokedAt === null)).toBe(true)
    expect(new Set(repository.rows.map((row) => row.serial)).size).toBe(2)
  })

  it.each([
    ['missing', undefined, SshCertificateErrorCode.SSH_PUBLIC_KEY_REQUIRED],
    ['malformed', 'ssh-ed25519 !!!', SshCertificateErrorCode.INVALID_PUBLIC_KEY],
  ])('rejects a %s public key without writing a row', async (_label, publicKey, code) => {
    const { service, repository } = buildService()

    await expect(service.issue(issueCommand({ publicKey }))).rejects.toMatchObject({ code })
    expect(repository.rows).toHaveLength(0)
  })

  it.each([0, 61, 5.5])('rejects out-of-policy TTL %p', async (expiresInMinutes) => {
    const { service, repository } = buildService()

    await expect(service.issue(issueCommand({ expiresInMinutes }))).rejects.toMatchObject({
      code: SshCertificateErrorCode.INVALID_TTL,
    })
    expect(repository.rows).toHaveLength(0)
  })

  it.each([1, 15, 30, 60])('accepts the allowed TTL of %p minutes', async (expiresInMinutes) => {
    const { service } = buildService()

    const credential = await service.issue(issueCommand({ expiresInMinutes }))

    expect(credential.expiresAt.getTime() - credential.validAfter.getTime()).toBe(
      expiresInMinutes * 60 * 1000 + 30 * 1000,
    )
  })

  it('enforces the active credential cap', async () => {
    const { service, repository } = buildService({ 'sshCertificate.maxActiveCredentialsPerBox': 2 })

    await service.issue(issueCommand())
    await service.issue(issueCommand())

    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.TOO_MANY_ACTIVE_CREDENTIALS,
    })
    expect(repository.rows).toHaveLength(2)
  })

  it('lets a revoked credential free capacity under the active cap', async () => {
    const { service } = buildService({ 'sshCertificate.maxActiveCredentialsPerBox': 1 })

    const first = await service.issue(issueCommand())
    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.TOO_MANY_ACTIVE_CREDENTIALS,
    })

    await service.revoke({ boxId: BOX_ID, organizationId: ORGANIZATION_ID, credentialId: first.id })

    await expect(service.issue(issueCommand())).resolves.toBeDefined()
  })

  it('enforces the issuance rate limit independently of revocation', async () => {
    const { service, repository } = buildService({
      'sshCertificate.issueRateLimit': { limit: 2, windowSeconds: 60 },
      'sshCertificate.maxActiveCredentialsPerBox': 100,
    })

    const first = await service.issue(issueCommand())
    await service.issue(issueCommand())
    await service.revoke({ boxId: BOX_ID, organizationId: ORGANIZATION_ID, credentialId: first.id })

    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.TOO_MANY_ACTIVE_CREDENTIALS,
    })
    expect(repository.rows).toHaveLength(2)
  })

  it('creates no row when the CA is unavailable', async () => {
    const failingSigner: SshCertificateSigner = {
      providerName: 'test',
      sign: async () => {
        throw SshCertificateError.caUnavailable('KMS Sign failed')
      },
    }
    const { service, repository } = buildService({}, failingSigner)

    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
    expect(repository.rows).toHaveLength(0)
  })

  it('maps an unexpected signer failure to SSH_CA_UNAVAILABLE without creating a row', async () => {
    const failingSigner: SshCertificateSigner = {
      providerName: 'test',
      sign: async () => {
        throw new Error('socket hang up')
      },
    }
    const { service, repository } = buildService({}, failingSigner)

    await expect(service.issue(issueCommand())).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
    expect(repository.rows).toHaveLength(0)
  })

  it('discards the signed certificate when the database write fails', async () => {
    const { service, repository } = buildService()
    repository.saveError = new Error('duplicate key value violates unique constraint')

    await expect(service.issue(issueCommand())).rejects.toThrow('duplicate key value violates unique constraint')
    expect(repository.rows).toHaveLength(0)
  })

  it('never logs the public key or certificate body', async () => {
    const { service } = buildService()
    const logged: unknown[] = []
    jest.spyOn(service['logger'], 'log').mockImplementation((entry: unknown) => {
      logged.push(entry)
    })

    const credential = await service.issue(issueCommand())

    const serialized = JSON.stringify(logged)
    expect(serialized).toContain(credential.fingerprint)
    expect(serialized).toContain(credential.id)
    expect(serialized).not.toContain(credential.certificate)
    expect(serialized).not.toContain(credential.publicKey)
  })
})

describe('SshCertificateService.revoke', () => {
  it('marks only the addressed credential revoked', async () => {
    const { service, repository } = buildService()
    const first = await service.issue(issueCommand())
    const second = await service.issue(issueCommand())

    const revoked = await service.revoke({
      boxId: BOX_ID,
      organizationId: ORGANIZATION_ID,
      credentialId: first.id,
    })

    expect(revoked.revokedAt).toBeInstanceOf(Date)
    expect(repository.rows.find((row) => row.id === second.id)?.revokedAt).toBeNull()
  })

  it('does not delete the row or rewrite the issued certificate', async () => {
    const { service, repository } = buildService()
    const credential = await service.issue(issueCommand())
    const issuedCertificate = credential.certificate

    await service.revoke({ boxId: BOX_ID, organizationId: ORGANIZATION_ID, credentialId: credential.id })

    const stored = repository.rows.find((row) => row.id === credential.id)
    expect(stored?.certificate).toBe(issuedCertificate)
    expect(stored?.expiresAt).toEqual(credential.expiresAt)
  })

  it('rejects a credential owned by another box or organization', async () => {
    const { service } = buildService()
    const credential = await service.issue(issueCommand())

    await expect(
      service.revoke({ boxId: 'box-other', organizationId: ORGANIZATION_ID, credentialId: credential.id }),
    ).rejects.toMatchObject({ code: SshCertificateErrorCode.SSH_CERTIFICATE_NOT_FOUND })
    await expect(
      service.revoke({ boxId: BOX_ID, organizationId: 'other-org', credentialId: credential.id }),
    ).rejects.toMatchObject({ code: SshCertificateErrorCode.SSH_CERTIFICATE_NOT_FOUND })
  })

  it('is idempotent for an already revoked credential', async () => {
    const { service } = buildService()
    const credential = await service.issue(issueCommand())

    const first = await service.revoke({
      boxId: BOX_ID,
      organizationId: ORGANIZATION_ID,
      credentialId: credential.id,
    })
    const second = await service.revoke({
      boxId: BOX_ID,
      organizationId: ORGANIZATION_ID,
      credentialId: credential.id,
    })

    expect(second.revokedAt).toEqual(first.revokedAt)
  })
})

describe('SshCertificateService.listActive', () => {
  it('hides revoked credentials and keeps the rest', async () => {
    const { service } = buildService()
    const first = await service.issue(issueCommand())
    const second = await service.issue(issueCommand())

    await service.revoke({ boxId: BOX_ID, organizationId: ORGANIZATION_ID, credentialId: first.id })

    const active = await service.listActive(BOX_ID, ORGANIZATION_ID)
    expect(active.map((row) => row.id)).toEqual([second.id])
  })
})
