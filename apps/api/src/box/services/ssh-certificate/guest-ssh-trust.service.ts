/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { TypedConfigService } from '../../../config/typed-config.service'
import { GuestSshTrustConfig } from './guest-ssh-trust'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'

/**
 * Resolves the CA trust bundle a *new* VM generation should be created with.
 *
 * Organization policy, not a user-facing option: a caller never chooses which
 * CA its box trusts — that would invert the trust boundary the design
 * establishes. An organization has guest SSH when an operator has provisioned
 * a `current` CA key for it; until then this resolves to `null` and the box
 * boots with no SSH listener at all.
 *
 * Resolution happens once, at create. The result is persisted on the Box and
 * replayed verbatim by start/stop and ordinary recover, so a rotation can
 * never take effect under a running box. A box picks up a rotated CA set only
 * by being replaced — a new Box, which comes back through here.
 */
@Injectable()
export class GuestSshTrustService {
  private readonly logger = new Logger(GuestSshTrustService.name)

  constructor(
    private readonly caKeyService: OrganizationSshCaKeyService,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Whether this organization has guest SSH at all.
   *
   * Self-contained, not a required precondition of {@link resolveForNewBox} —
   * it exists because the create path must decide whether a pre-warmed box is
   * servable before a box ID exists to resolve a full bundle against.
   */
  async isEnabledForOrganization(organizationId: string): Promise<boolean> {
    return (await this.caKeyService.findCurrent(organizationId)) !== null
  }

  /**
   * Build the trust bundle for a box about to be created, or `null` when the
   * organization has no CA and therefore no guest SSH.
   *
   * Both `current` and `next` are included when a rotation is in flight, so
   * the new generation keeps authenticating across the signer switch.
   */
  async resolveForNewBox(organizationId: string, boxId: string): Promise<GuestSshTrustConfig | null> {
    const current = await this.caKeyService.findCurrent(organizationId)
    if (!current) {
      return null
    }

    const next = await this.caKeyService.findNext(organizationId)
    const caKeys = [{ keyId: current.keyId, publicKey: current.publicKey }]
    if (next) {
      caKeys.push({ keyId: next.keyId, publicKey: next.publicKey })
    }

    // Key IDs only. The public keys are not secret, but they are bulky and
    // uninteresting in a log; the IDs are what a rotation is tracked by.
    this.logger.log(
      `resolved guest SSH trust for box ${boxId} (organization ${organizationId}): ${caKeys
        .map((key) => key.keyId)
        .join(', ')}`,
    )

    return {
      listenAddr: this.configService.get('sshCertificate.guestListenAddr'),
      organizationId,
      boxId,
      caKeys,
    }
  }
}
