/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BoxAccessGrant } from '../entities/box-access-grant.entity'
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { RunnerService } from './runner.service'
import { BoxSshReconciliationService } from './box-ssh-reconciliation.service'
import { SshAccessSetAdapter } from '../runner-adapter/ssh-access-set.adapter'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { generateApiKeyHash, generateApiKeyValue } from '../../common/utils/api-key'
import { TypedConfigService } from '../../config/typed-config.service'
import { CreateBoxAccessGrantDto, BoxAccessGrantDto, BoxAccessGrantResponseDto } from '../dto/box-access-grant.dto'

// Distinct from the deployment-configured `apiKey.prefix` (user dashboard
// keys): a fixed, visually distinguishable prefix so support tooling and log
// scrubbers can tell a box-scoped app-grant secret apart from a user API key
// on sight. `svc` class: non-human, delegated credential, like runner/region
// keys.
const APP_KEY_PREFIX = 'bag'

@Injectable()
export class BoxAccessGrantService {
  private static readonly MIN_EXPIRES_IN_SECONDS = 60
  private static readonly MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24
  private static readonly DEFAULT_EXPIRES_IN_SECONDS = 60 * 60

  constructor(
    @InjectRepository(BoxAccessGrant)
    private readonly boxAccessGrantRepository: Repository<BoxAccessGrant>,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly reconciliationService: BoxSshReconciliationService,
    private readonly sshAccessSetAdapter: SshAccessSetAdapter,
    private readonly configService: TypedConfigService,
  ) {}

  async create(
    boxIdOrName: string,
    dto: CreateBoxAccessGrantDto,
    organizationId: string,
    createdBy: string,
  ): Promise<BoxAccessGrantResponseDto> {
    if (!this.configService.get('sshIssuanceEnabled')) {
      throw new ServiceUnavailableException('SSH access-grant issuance is currently disabled')
    }
    const scopes = this.validateScopes(dto.scopes)
    const expiresInSeconds = this.validateExpiresInSeconds(dto.expiresInSeconds)

    const box = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)

    const appKey = generateApiKeyValue(APP_KEY_PREFIX, 'svc')

    const grant = await this.boxAccessGrantRepository.save({
      boxId: box.id,
      secretDigest: generateApiKeyHash(appKey),
      scopes,
      status: BoxAccessGrantStatus.ACTIVE,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      createdBy,
    })

    return BoxAccessGrantResponseDto.fromGrant(grant, appKey)
  }

  async list(boxIdOrName: string, organizationId: string): Promise<BoxAccessGrantDto[]> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)

    const grants = await this.boxAccessGrantRepository.find({
      where: { boxId: box.id },
      order: { createdAt: 'DESC' },
    })

    return grants.map((grant) => BoxAccessGrantDto.fromGrant(grant))
  }

  // Marks the grant ACTIVE -> REVOKED and cascades to every credential
  // issued under it: computeDesiredAccessSet only includes credentials whose
  // parent grant is still ACTIVE, so pushing a fresh access-set snapshot
  // after flipping the grant's own status drops all of them from the guest
  // in the same call -- mirrors TemporarySshCredentialService.revoke()'s
  // running/stopped split and REVOKING transitional state.
  async revoke(boxIdOrName: string, grantId: string, organizationId: string): Promise<void> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)

    const grant = await this.boxAccessGrantRepository.findOne({
      where: { id: grantId, boxId: box.id },
    })
    if (!grant) {
      throw new NotFoundException(`Access grant ${grantId} not found for box ${box.id}`)
    }

    // Idempotent: revoking an already-revoked grant is a safe no-op rather
    // than an error, matching the existing revokeSshAccess delete-if-present
    // convention in box.service.ts.
    if (grant.status === BoxAccessGrantStatus.REVOKED) {
      return
    }

    if (box.state !== BoxState.STARTED || !box.runnerId) {
      grant.status = BoxAccessGrantStatus.REVOKED
      await this.boxAccessGrantRepository.save(grant)
      return
    }

    grant.status = BoxAccessGrantStatus.REVOKING
    await this.boxAccessGrantRepository.save(grant)

    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    const { generation, accesses } = await this.reconciliationService.computeDesiredAccessSet(box.id)
    await this.sshAccessSetAdapter.applyAccessSet(runner, box.id, generation, accesses)

    grant.status = BoxAccessGrantStatus.REVOKED
    await this.boxAccessGrantRepository.save(grant)
  }

  // Org-authenticated lookup: the credential service uses this to validate
  // a `grantId` supplied by an account-authenticated caller belongs to the
  // box and organization it claims.
  async findActiveForBox(boxId: string, grantId: string): Promise<BoxAccessGrant> {
    const grant = await this.boxAccessGrantRepository.findOne({ where: { id: grantId, boxId } })
    if (!grant || grant.status !== BoxAccessGrantStatus.ACTIVE || grant.expiresAt <= new Date()) {
      throw new NotFoundException(`Active access grant ${grantId} not found for box ${boxId}`)
    }
    return grant
  }

  // App-key-authenticated lookup: proves the caller holds the plaintext
  // secret for an active, non-expired grant, without any organization
  // session. Never logs the presented key; only its digest is compared.
  async findActiveByAppKey(appKey: string): Promise<BoxAccessGrant> {
    const grant = await this.boxAccessGrantRepository.findOne({
      where: { secretDigest: generateApiKeyHash(appKey) },
    })
    if (!grant || grant.status !== BoxAccessGrantStatus.ACTIVE || grant.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired app key')
    }
    return grant
  }

  private validateScopes(scopes: BoxAccessGrantScope[]): BoxAccessGrantScope[] {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new BadRequestError('scopes must be a non-empty array')
    }

    const allowedScopes = new Set(Object.values(BoxAccessGrantScope))
    const unsupportedScopes = scopes.filter((scope) => !allowedScopes.has(scope))
    if (unsupportedScopes.length > 0) {
      throw new BadRequestError(`Unsupported access grant scope(s): ${unsupportedScopes.join(', ')}`)
    }

    return Array.from(new Set(scopes))
  }

  private validateExpiresInSeconds(expiresInSeconds = BoxAccessGrantService.DEFAULT_EXPIRES_IN_SECONDS): number {
    if (
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds < BoxAccessGrantService.MIN_EXPIRES_IN_SECONDS ||
      expiresInSeconds > BoxAccessGrantService.MAX_EXPIRES_IN_SECONDS
    ) {
      throw new BadRequestError(
        `expiresInSeconds must be between ${BoxAccessGrantService.MIN_EXPIRES_IN_SECONDS} and ${BoxAccessGrantService.MAX_EXPIRES_IN_SECONDS} seconds`,
      )
    }
    return expiresInSeconds
  }
}
