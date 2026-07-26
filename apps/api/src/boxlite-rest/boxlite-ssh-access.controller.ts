/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { BoxService } from '../box/services/box.service'
import { SshCertificateService } from '../box/services/ssh-certificate/ssh-certificate.service'
import { SshCertificateError } from '../box/services/ssh-certificate/ssh-certificate.errors'
import {
  CreateSshCertificateRequestDto,
  ListSshCertificatesResponseDto,
  SshCertificateCredentialDto,
} from './dto/ssh-certificate.dto'
import { SSH_GUEST_PORT, sshCertificateToDto } from './mappers/ssh-certificate.mapper'

/**
 * Canonical Box API sub-resource for SSH certificate credentials.
 *
 * Spec-first surface: the contract is `openapi/box.openapi.yaml`, not the
 * generated product spec, hence `@ApiExcludeController()` — these Box
 * operations must never leak into the Cloud API document.
 *
 * This deliberately does NOT rebind the deleted Legacy SSH Token routes. Those
 * were removed outright; this is a new resource with its own contract.
 */
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteSshAccessController {
  constructor(
    private readonly boxService: BoxService,
    private readonly sshCertificateService: SshCertificateService,
  ) {}

  @Post(':boxId/ssh-access/certificates')
  @HttpCode(HttpStatus.CREATED)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async createCertificate(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Body() body: CreateSshCertificateRequestDto | undefined,
    @Query('expiresInMinutes') expiresInMinutes?: string,
  ): Promise<SshCertificateCredentialDto> {
    // A body-less request must fail with the documented code rather than a
    // generic validation error, so `publicKey` being mandatory is observable
    // in the contract.
    if (!body?.public_key) {
      throw SshCertificateError.publicKeyRequired()
    }

    // Resolve the box BEFORE signing. This is the ownership check, and it is
    // the only one: the guards authorize the organization and `WRITE_BOXES`
    // but never look at `boxId`. Signing first would spend a KMS operation and
    // persist a credential row for a box the caller may not own — or that may
    // not exist — and would let a caller cycle `boxId` to slip the
    // per-box issuance rate limit.
    const tunnelUri = await this.tunnelUri(boxId, authContext)

    const credential = await this.sshCertificateService.issue({
      boxId,
      organizationId: authContext.organizationId,
      publicKey: body.public_key,
      expiresInMinutes: parseTtlMinutes(expiresInMinutes),
    })

    return sshCertificateToDto(credential, tunnelUri)
  }

  @Get(':boxId/ssh-access/certificates')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async listCertificates(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<ListSshCertificatesResponseDto> {
    // Ownership first, for the same reason as create: an unknown or foreign
    // box must be a 404, not an empty list that looks like "no credentials".
    const tunnelUri = await this.tunnelUri(boxId, authContext)
    const credentials = await this.sshCertificateService.listActive(boxId, authContext.organizationId)
    return { certificates: credentials.map((c) => sshCertificateToDto(c, tunnelUri)) }
  }

  @Delete(':boxId/ssh-access/certificates/:credentialId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async revokeCertificate(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('credentialId') credentialId: string,
  ): Promise<void> {
    // Revokes exactly the addressed credential. There is no revoke-all in this
    // contract, and other active credentials for the box are untouched.
    await this.sshCertificateService.revoke({
      boxId,
      organizationId: authContext.organizationId,
      credentialId,
    })
  }

  /**
   * Region-aware endpoint for guest port 22, and this resource's box
   * ownership check.
   *
   * `getNetworkTunnelUrl` is the single construction point for tunnel
   * hostnames, and it resolves the box with `findOneByIdOrName(boxId,
   * organizationId)`, throwing for a box the organization does not own. Call
   * it before anything irreversible — it only guards what runs after it.
   */
  private async tunnelUri(boxId: string, authContext: OrganizationAuthContext): Promise<string> {
    return this.boxService.getNetworkTunnelUrl(boxId, authContext.organizationId, SSH_GUEST_PORT)
  }
}

/**
 * Parse the TTL query parameter.
 *
 * Absent means "use the server default". A present-but-not-a-number value is
 * passed through as `NaN` so the service's TTL policy rejects it with
 * `INVALID_TTL`, rather than this controller silently substituting the default
 * for a value the caller explicitly asked for.
 */
function parseTtlMinutes(raw?: string): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined
  }
  return Number(raw)
}
