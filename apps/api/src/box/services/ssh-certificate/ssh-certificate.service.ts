/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { randomBytes, randomUUID } from 'crypto'
import { IsNull, MoreThan, Repository } from 'typeorm'
import { TypedConfigService } from '../../../config/typed-config.service'
import { SshCertificateCredential } from '../../entities/ssh-certificate-credential.entity'
import { parseSshPublicKey } from './openssh-public-key'
import {
  SignedSshCertificate,
  SSH_CERTIFICATE_SIGNER,
  SshCertificateSigner,
  SshCertificateSignRequest,
} from './ssh-certificate-signer'
import { SshCertificateError } from './ssh-certificate.errors'

/** The only SSH login the certificate profile authorizes. */
export const SSH_CERTIFICATE_LOGIN_USERNAME = 'root'

export interface IssueSshCertificateCommand {
  boxId: string
  organizationId: string
  /** Raw client-supplied OpenSSH public key; validated here, never logged. */
  publicKey: unknown
  expiresInMinutes?: number
}

export interface RevokeSshCertificateCommand {
  boxId: string
  organizationId: string
  credentialId: string
}

/**
 * Issues, lists and revokes short-lived OpenSSH user certificates for a box.
 *
 * Issuance never touches other credentials: several certificates may be active
 * for the same box at once, and revocation only ever marks the one addressed by
 * ID.
 */
@Injectable()
export class SshCertificateService {
  private readonly logger = new Logger(SshCertificateService.name)

  constructor(
    @InjectRepository(SshCertificateCredential)
    private readonly credentialRepository: Repository<SshCertificateCredential>,
    @Inject(SSH_CERTIFICATE_SIGNER)
    private readonly signer: SshCertificateSigner,
    private readonly configService: TypedConfigService,
  ) {}

  async issue(command: IssueSshCertificateCommand): Promise<SshCertificateCredential> {
    if (!this.configService.get('sshCertificate.issuanceEnabled')) {
      throw SshCertificateError.issuanceDisabled()
    }

    const publicKey = parseSshPublicKey(command.publicKey)
    const ttlMinutes = this.resolveTtlMinutes(command.expiresInMinutes)
    await this.assertIssuanceAllowed(command.boxId, command.organizationId)

    const credentialId = randomUUID()
    const serial = allocateSerial()
    const issuedAt = new Date()
    const validAfter = new Date(issuedAt.getTime() - this.configService.get('sshCertificate.clockSkewSeconds') * 1000)
    const validBefore = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000)

    const signed = await this.sign({
      organizationId: command.organizationId,
      boxId: command.boxId,
      loginUsername: SSH_CERTIFICATE_LOGIN_USERNAME,
      validPrincipals: buildValidPrincipals(command.boxId, command.organizationId),
      // The OpenSSH `key id` is the SSH access record ID, so an audited
      // certificate maps back to exactly one credential row.
      keyId: credentialId,
      serial,
      publicKey,
      validAfter,
      validBefore,
    })

    const credential = this.credentialRepository.create({
      id: credentialId,
      boxId: command.boxId,
      organizationId: command.organizationId,
      certificate: signed.certificate,
      publicKey: publicKey.openssh,
      fingerprint: publicKey.fingerprint,
      serial: signed.serial.toString(),
      caKeyId: signed.caKeyId,
      validAfter,
      expiresAt: validBefore,
      revokedAt: null,
    })

    try {
      await this.credentialRepository.save(credential)
    } catch (error) {
      // The signed certificate was never disclosed, so it is unusable and will
      // expire on its own. Drop it rather than returning an unrecorded credential.
      this.logger.error({
        message: 'SSH certificate issuance',
        result: 'failure',
        reason: 'persistence_failed',
        credentialId,
        boxId: command.boxId,
        organizationId: command.organizationId,
        caKeyId: signed.caKeyId,
        serial: signed.serial.toString(),
        fingerprint: publicKey.fingerprint,
        ttlMinutes,
      })
      throw error
    }

    // Audit trail: identifiers and fingerprints only, never key or certificate bodies.
    this.logger.log({
      message: 'SSH certificate issuance',
      result: 'success',
      credentialId,
      boxId: command.boxId,
      organizationId: command.organizationId,
      caKeyId: signed.caKeyId,
      serial: signed.serial.toString(),
      fingerprint: publicKey.fingerprint,
      ttlMinutes,
    })

    return credential
  }

  /** Credentials that are neither revoked nor expired, newest first. */
  async listActive(boxId: string, organizationId: string): Promise<SshCertificateCredential[]> {
    return this.credentialRepository.find({
      where: { boxId, organizationId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    })
  }

  /**
   * Marks a single credential revoked. Already-issued certificates stay valid
   * until `expiresAt`; revocation only hides the credential
   * from the active list.
   */
  async revoke(command: RevokeSshCertificateCommand): Promise<SshCertificateCredential> {
    const credential = await this.credentialRepository.findOne({
      where: { id: command.credentialId, boxId: command.boxId, organizationId: command.organizationId },
    })

    if (!credential) {
      throw SshCertificateError.notFound(command.credentialId)
    }

    if (credential.revokedAt) {
      return credential
    }

    credential.revokedAt = new Date()
    await this.credentialRepository.save(credential)

    this.logger.log({
      message: 'Revoked SSH certificate credential',
      credentialId: credential.id,
      boxId: credential.boxId,
      organizationId: credential.organizationId,
      caKeyId: credential.caKeyId,
      serial: credential.serial,
      fingerprint: credential.fingerprint,
    })

    return credential
  }

  private async sign(request: SshCertificateSignRequest): Promise<SignedSshCertificate> {
    try {
      return await this.signer.sign(request)
    } catch (error) {
      // No row is created when the CA is unusable.
      if (error instanceof SshCertificateError) {
        throw error
      }
      throw SshCertificateError.caUnavailable(`signer "${this.signer.providerName}" failed`, error)
    }
  }

  private resolveTtlMinutes(requested?: number): number {
    const minTtlMinutes = this.configService.get('sshCertificate.minTtlMinutes')
    const maxTtlMinutes = this.configService.get('sshCertificate.maxTtlMinutes')

    if (requested === undefined || requested === null) {
      return this.configService.get('sshCertificate.defaultTtlMinutes')
    }
    if (!Number.isInteger(requested)) {
      throw SshCertificateError.invalidTtl('expiresInMinutes must be an integer number of minutes')
    }
    if (requested < minTtlMinutes || requested > maxTtlMinutes) {
      throw SshCertificateError.invalidTtl(
        `expiresInMinutes must be between ${minTtlMinutes} and ${maxTtlMinutes} minutes`,
      )
    }
    return requested
  }

  private async assertIssuanceAllowed(boxId: string, organizationId: string): Promise<void> {
    const rateLimit = this.configService.get('sshCertificate.issueRateLimit')
    const windowStart = new Date(Date.now() - rateLimit.windowSeconds * 1000)
    const recentCount = await this.credentialRepository.count({
      where: { boxId, organizationId, createdAt: MoreThan(windowStart) },
    })
    if (recentCount >= rateLimit.limit) {
      throw SshCertificateError.tooManyActiveCredentials(
        `SSH certificate issuance rate limit reached for this box: ${rateLimit.limit} per ${rateLimit.windowSeconds}s`,
      )
    }

    const maxActive = this.configService.get('sshCertificate.maxActiveCredentialsPerBox')
    const activeCount = await this.credentialRepository.count({
      where: { boxId, organizationId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    })
    if (activeCount >= maxActive) {
      throw SshCertificateError.tooManyActiveCredentials(
        `This box already has ${activeCount} active SSH certificate credentials (limit ${maxActive})`,
      )
    }
  }

}

function buildValidPrincipals(boxId: string, organizationId: string): readonly string[] {
  return [SSH_CERTIFICATE_LOGIN_USERNAME, `box:${boxId}`, `org:${organizationId}`]
}

/**
 * 63-bit random serial: unique within the organization by construction plus the
 * `(organizationId, serial)` unique constraint, and always positive so it
 * round-trips through PostgreSQL's signed `bigint`.
 */
function allocateSerial(): bigint {
  const bytes = randomBytes(8)
  bytes[0] &= 0x7f
  return bytes.readBigUInt64BE(0)
}
