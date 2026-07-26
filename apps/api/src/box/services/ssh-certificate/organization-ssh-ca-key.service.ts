/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { OrganizationSshCaKey, OrganizationSshCaKeyStatus } from '../../entities/organization-ssh-ca-key.entity'
import { SshCertificateError } from './ssh-certificate.errors'

/**
 * Reads the organization-scoped CA trust domain. Rows are provisioned and
 * rotated by the CA rotation runbook; the API only resolves the signing key.
 */
@Injectable()
export class OrganizationSshCaKeyService {
  constructor(
    @InjectRepository(OrganizationSshCaKey)
    private readonly caKeyRepository: Repository<OrganizationSshCaKey>,
  ) {}

  /**
   * @throws SshCertificateError `SSH_CA_UNAVAILABLE` when the organization has
   * no current CA key.
   */
  async getCurrent(organizationId: string): Promise<OrganizationSshCaKey> {
    const caKey = await this.caKeyRepository.findOne({
      where: { organizationId, status: OrganizationSshCaKeyStatus.CURRENT },
    })

    if (!caKey) {
      throw SshCertificateError.caUnavailable(`no current CA key for organization ${organizationId}`)
    }

    return caKey
  }

  /**
   * The organization's current CA key, or `null` when it has none.
   *
   * Unlike {@link getCurrent} this does not throw: guest SSH trust is optional
   * per organization, and "no CA provisioned" means "SSH not enabled here",
   * not "the signer is broken".
   */
  async findCurrent(organizationId: string): Promise<OrganizationSshCaKey | null> {
    return this.caKeyRepository.findOne({
      where: { organizationId, status: OrganizationSshCaKeyStatus.CURRENT },
    })
  }

  /**
   * The organization's `next` CA key while a rotation is in flight.
   *
   * Boxes created during a rotation must trust current *and* next, so that
   * switching the signer to `next` does not lock them out before they are
   * recreated.
   */
  async findNext(organizationId: string): Promise<OrganizationSshCaKey | null> {
    return this.caKeyRepository.findOne({
      where: { organizationId, status: OrganizationSshCaKeyStatus.NEXT },
    })
  }
}
