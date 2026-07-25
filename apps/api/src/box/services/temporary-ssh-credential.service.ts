/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Not, Repository } from 'typeorm'
import { TemporarySshCredential } from '../entities/temporary-ssh-credential.entity'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'
import { BoxAccessGrant } from '../entities/box-access-grant.entity'
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxSshIdentity } from '../entities/box-ssh-identity.entity'
import { BoxSshIdentityStatus } from '../enums/box-ssh-identity-status.enum'
import { BoxState } from '../enums/box-state.enum'
import { Box } from '../entities/box.entity'
import { BoxService, encodeDirectPreviewBoxId } from './box.service'
import { RunnerService } from './runner.service'
import { BoxSshReconciliationService } from './box-ssh-reconciliation.service'
import { SshAccessSetAdapter } from '../runner-adapter/ssh-access-set.adapter'
import { parseSshPublicKey, SshPublicKeyError } from '../../common/utils/ssh-public-key'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { TypedConfigService } from '../../config/typed-config.service'
import {
  CreateTemporarySshCredentialDto,
  TemporarySshCredentialDto,
  TemporarySshCredentialResponseDto,
} from '../dto/temporary-ssh-credential.dto'

// Fixed per the design; kept as a constant (not a per-request input) so a
// caller can't ask for a different remote user.
const SSH_UNIX_USER = 'root'
const DEFAULT_EXPIRES_IN_SECONDS = 300
const PROXY_TUNNEL_PORT = 443
const SSH_ENDPOINT_PORT = 22

@Injectable()
export class TemporarySshCredentialService {
  constructor(
    @InjectRepository(TemporarySshCredential)
    private readonly credentialRepository: Repository<TemporarySshCredential>,
    @InjectRepository(BoxSshIdentity)
    private readonly identityRepository: Repository<BoxSshIdentity>,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly reconciliationService: BoxSshReconciliationService,
    private readonly sshAccessSetAdapter: SshAccessSetAdapter,
    private readonly configService: TypedConfigService,
  ) {}

  // Create requires a guest ack before the credential is ever reported
  // active: the candidate row starts PENDING, the full access-set (including
  // the candidate) is applied to the running guest, and only a successful
  // apply promotes it to ACTIVE. A box that isn't running has no guest to
  // ack, so create fails outright rather than leaving a row that silently
  // never becomes usable.
  async create(
    boxIdOrName: string,
    dto: CreateTemporarySshCredentialDto,
    grant: BoxAccessGrant,
    createdBy: string,
  ): Promise<TemporarySshCredentialResponseDto> {
    if (!this.configService.get('sshIssuanceEnabled')) {
      throw new ServiceUnavailableException('SSH credential issuance is currently disabled')
    }
    const box = await this.boxService.findOneByIdOrName(boxIdOrName)
    if (box.id !== grant.boxId) {
      throw new ForbiddenException(`Access grant ${grant.id} does not belong to box ${box.id}`)
    }
    if (!grant.scopes.includes(BoxAccessGrantScope.SSH)) {
      throw new ForbiddenException(`Access grant ${grant.id} does not have the "ssh" scope`)
    }

    const parsedKey = this.parsePublicKey(dto.publicKey)
    const expiresAt = this.resolveExpiresAt(dto.expiresInSeconds, grant.expiresAt)

    const duplicate = await this.credentialRepository.findOne({
      where: {
        boxId: box.id,
        publicKeyFingerprint: parsedKey.fingerprint,
        unixUser: SSH_UNIX_USER,
        status: Not(TemporarySshCredentialStatus.REVOKED),
      },
    })
    if (duplicate) {
      throw new ConflictException(`An active credential for this key already exists on box ${box.id}`)
    }

    if (box.state !== BoxState.STARTED || !box.runnerId) {
      throw new ConflictException(`Box ${box.id} must be running to create an SSH credential`)
    }

    const identity = await this.identityRepository.findOne({ where: { boxId: box.id } })
    if (identity?.status === BoxSshIdentityStatus.DEGRADED) {
      throw new ConflictException(
        `Box ${box.id} has an unexplained SSH host identity change and is degraded; new credentials are blocked until it is resolved`,
      )
    }

    const runner = await this.runnerService.findOneOrFail(box.runnerId)

    const candidate: TemporarySshCredential = await this.credentialRepository.save({
      grantId: grant.id,
      boxId: box.id,
      publicKey: parsedKey.canonicalLine,
      publicKeyFingerprint: parsedKey.fingerprint,
      unixUser: SSH_UNIX_USER,
      status: TemporarySshCredentialStatus.PENDING,
      expiresAt,
      createdBy,
    })

    const { generation, accesses } = await this.reconciliationService.computeDesiredAccessSet(box.id)
    accesses.push({
      id: candidate.id,
      grantId: grant.id,
      publicKey: parsedKey.canonicalLine,
      fingerprint: parsedKey.fingerprint,
      unixUser: SSH_UNIX_USER,
      expiresAt,
    })

    let applyStatus
    try {
      applyStatus = await this.sshAccessSetAdapter.applyAccessSet(runner, box.id, generation, accesses)
    } catch (error) {
      // Apply failed: the guest never acked this credential, so it must not
      // be reported as created at all.
      await this.credentialRepository.remove(candidate)
      throw error
    }

    candidate.status = TemporarySshCredentialStatus.ACTIVE
    await this.credentialRepository.save(candidate)

    return TemporarySshCredentialResponseDto.build(candidate, {
      endpoint: this.endpointHost(box),
      proxyCommand: this.proxyCommand(),
      hostPublicKey: applyStatus.hostPublicKey,
      hostKeyFingerprint: applyStatus.hostKeyFingerprint,
    })
  }

  async list(boxIdOrName: string, organizationId: string): Promise<TemporarySshCredentialDto[]> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)
    const credentials = await this.credentialRepository.find({
      where: { boxId: box.id },
      order: { createdAt: 'DESC' },
    })
    return credentials.map((credential) => TemporarySshCredentialDto.fromCredential(credential))
  }

  // Running box: mark REVOKING, push a snapshot excluding this credential,
  // and only mark REVOKED once the guest acks -- a failed apply must leave
  // status visibly REVOKING and retryable, never a false "revoked" claim.
  // Stopped box: no guest to ack, so revoke persists immediately; the next
  // start reconciles before SSH becomes ready (a separate lifecycle task).
  async revoke(boxIdOrName: string, credentialId: string, organizationId: string): Promise<void> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)
    const credential = await this.credentialRepository.findOne({ where: { id: credentialId, boxId: box.id } })
    if (!credential) {
      throw new NotFoundException(`SSH credential ${credentialId} not found for box ${box.id}`)
    }
    if (credential.status === TemporarySshCredentialStatus.REVOKED) {
      return
    }

    if (box.state !== BoxState.STARTED || !box.runnerId) {
      credential.status = TemporarySshCredentialStatus.REVOKED
      await this.credentialRepository.save(credential)
      return
    }

    credential.status = TemporarySshCredentialStatus.REVOKING
    await this.credentialRepository.save(credential)

    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    const { generation, accesses } = await this.reconciliationService.computeDesiredAccessSet(box.id)
    await this.sshAccessSetAdapter.applyAccessSet(runner, box.id, generation, accesses)

    credential.status = TemporarySshCredentialStatus.REVOKED
    await this.credentialRepository.save(credential)
  }

  private parsePublicKey(line: string) {
    try {
      return parseSshPublicKey(line)
    } catch (error) {
      if (error instanceof SshPublicKeyError) {
        throw new BadRequestError(error.message)
      }
      throw error
    }
  }

  private resolveExpiresAt(expiresInSeconds: number | undefined, grantExpiresAt: Date): Date {
    const requested = new Date(Date.now() + (expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000)
    return requested < grantExpiresAt ? requested : grantExpiresAt
  }

  private endpointHost(box: Box): string {
    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    return `${SSH_ENDPOINT_PORT}-${encodeDirectPreviewBoxId(box.id)}.${proxyDomain}`
  }

  private proxyCommand(): string {
    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    return `proxytunnel -q -E -p ${proxyDomain}:${PROXY_TUNNEL_PORT} -d %h:%p`
  }
}
