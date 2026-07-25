/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { TemporarySshCredential } from '../entities/temporary-ssh-credential.entity'
import { BoxSshAccessGeneration } from '../entities/box-ssh-access-generation.entity'
import { BoxAccessGrant } from '../entities/box-access-grant.entity'
import { BoxSshIdentity } from '../entities/box-ssh-identity.entity'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'
import { BoxSshIdentityStatus } from '../enums/box-ssh-identity-status.enum'
import { Runner } from '../entities/runner.entity'
import { SshAccessSetAdapter, SshAccessSetEntry, SshAccessSetStatus } from '../runner-adapter/ssh-access-set.adapter'

export interface DesiredAccessSet {
  generation: number
  accesses: SshAccessSetEntry[]
}

// Bounded-reconciliation source of truth: re-derives a box's desired guest
// SSH access set from current DB state and pushes it through the Runner
// control-plane adapter. Box start/restart lifecycle hooks call
// `reconcileOnStart` so the guest's applied generation never drifts from
// Postgres; destroy calls `cleanupForDestroyedBox`. This service does not
// itself decide when reconciliation should run.
@Injectable()
export class BoxSshReconciliationService {
  private readonly logger = new Logger(BoxSshReconciliationService.name)

  constructor(
    @InjectRepository(TemporarySshCredential)
    private readonly credentialRepository: Repository<TemporarySshCredential>,
    @InjectRepository(BoxSshAccessGeneration)
    private readonly generationRepository: Repository<BoxSshAccessGeneration>,
    private readonly sshAccessSetAdapter: SshAccessSetAdapter,
    @InjectRepository(BoxAccessGrant)
    private readonly grantRepository: Repository<BoxAccessGrant>,
    @InjectRepository(BoxSshIdentity)
    private readonly identityRepository: Repository<BoxSshIdentity>,
  ) {}

  // Queries active, non-expired credentials whose parent grant is also
  // active and non-expired, then allocates the next generation for the
  // resulting snapshot. Callers that only need the snapshot for inspection
  // (not application) still get a freshly allocated generation -- that's an
  // accepted trade-off of keeping the counter allocation and the query atomic
  // to the same call, rather than needing a second round-trip to "commit" it.
  async computeDesiredAccessSet(boxId: string): Promise<DesiredAccessSet> {
    const now = new Date()

    const credentials = await this.credentialRepository
      .createQueryBuilder('credential')
      .innerJoin('credential.grant', 'grant')
      .where('credential.boxId = :boxId', { boxId })
      .andWhere('credential.status = :credentialStatus', {
        credentialStatus: TemporarySshCredentialStatus.ACTIVE,
      })
      .andWhere('credential.expiresAt > :now', { now })
      .andWhere('grant.status = :grantStatus', { grantStatus: BoxAccessGrantStatus.ACTIVE })
      .andWhere('grant.expiresAt > :now', { now })
      .getMany()

    const generation = await this.nextGeneration(boxId)

    return {
      generation,
      accesses: credentials.map((credential) => ({
        id: credential.id,
        grantId: credential.grantId,
        publicKey: credential.publicKey,
        fingerprint: credential.publicKeyFingerprint,
        unixUser: credential.unixUser,
        expiresAt: credential.expiresAt,
      })),
    }
  }

  // Computes the desired snapshot and applies it via the Runner adapter in
  // one call, for lifecycle hooks that just want "make the guest match the
  // DB" without handling the intermediate snapshot themselves.
  async reconcile(runner: Runner, boxId: string): Promise<SshAccessSetStatus> {
    const { generation, accesses } = await this.computeDesiredAccessSet(boxId)
    const status = await this.sshAccessSetAdapter.applyAccessSet(runner, boxId, generation, accesses)
    // The only success-path log for this call: sync lag (time since a box's
    // last successful reconcile) is only derivable from log timestamps today
    // -- there's no "last applied generation" column to query instead.
    this.logger.log(
      `SSH access set reconciled for box ${boxId}: generation=${status.appliedGeneration} listenerReady=${status.listenerReady} accessCount=${accesses.length}`,
    )
    return status
  }

  // Best-effort variant for box start/restart: SSH is a secondary capability
  // of the box, so a reconciliation failure must not fail the box's own
  // start action -- it's logged and the guest is left to catch up on the
  // next successful reconcile. `wasRestoring` distinguishes an approved
  // snapshot-restore/import rotation (design: the guest-rootfs disk can be
  // rebuilt, so a fresh host key is expected) from a normal stop/start
  // (where a changed host key is never expected and must fail closed).
  async reconcileOnStart(runner: Runner, boxId: string, wasRestoring: boolean): Promise<void> {
    let status: SshAccessSetStatus
    try {
      status = await this.reconcile(runner, boxId)
    } catch (error) {
      this.logger.warn(`SSH reconciliation failed for box ${boxId} on start: ${error.message}`)
      return
    }
    await this.recordObservedIdentity(boxId, status, wasRestoring)
  }

  private async recordObservedIdentity(
    boxId: string,
    status: SshAccessSetStatus,
    wasRestoring: boolean,
  ): Promise<void> {
    const now = new Date()
    const existing = await this.identityRepository.findOne({ where: { boxId } })

    if (!existing) {
      await this.identityRepository.save({
        boxId,
        algorithm: 'ssh-ed25519',
        publicKey: status.hostPublicKey,
        fingerprint: status.hostKeyFingerprint,
        identityGeneration: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        status: BoxSshIdentityStatus.READY,
      })
      return
    }

    if (existing.fingerprint === status.hostKeyFingerprint) {
      existing.lastSeenAt = now
      existing.status = BoxSshIdentityStatus.READY
      await this.identityRepository.save(existing)
      return
    }

    if (wasRestoring) {
      existing.publicKey = status.hostPublicKey
      existing.fingerprint = status.hostKeyFingerprint
      existing.identityGeneration += 1
      existing.lastSeenAt = now
      existing.status = BoxSshIdentityStatus.READY
      await this.identityRepository.save(existing)
      return
    }

    // Unexplained mismatch outside an approved restore/import: fail closed.
    // `TemporarySshCredentialService.create` checks this status and refuses
    // new credentials while degraded.
    existing.lastSeenAt = now
    existing.status = BoxSshIdentityStatus.DEGRADED
    await this.identityRepository.save(existing)
    this.logger.error(
      `Unexplained SSH host identity change for box ${boxId}: expected ${existing.fingerprint}, observed ${status.hostKeyFingerprint}`,
    )
  }

  // Destroy cascade: the `box` row itself is soft-transitioned to DESTROYED
  // rather than deleted, so the FK `ON DELETE CASCADE` on these tables never
  // fires for a normal destroy -- this explicitly removes what the design's
  // ownership table requires cleaned up at that point. Deleting
  // `box_access_grant` rows also cascades to their child
  // `temporary_ssh_credential` rows at the DB level; the credential table is
  // still cleared directly first as a defensive measure against any
  // orphaned rows.
  async cleanupForDestroyedBox(boxId: string): Promise<void> {
    await this.credentialRepository.delete({ boxId })
    await this.grantRepository.delete({ boxId })
    await this.identityRepository.delete({ boxId })
    await this.generationRepository.delete({ boxId })
  }

  // Atomic upsert-and-increment: avoids a read-then-write race between
  // concurrent reconcile calls for the same box, which a
  // `SELECT ... then UPDATE` pair would not.
  private async nextGeneration(boxId: string): Promise<number> {
    const rows = await this.generationRepository.manager.query(
      `INSERT INTO "box_ssh_access_generation" ("boxId", "generation", "updatedAt")
       VALUES ($1, 1, now())
       ON CONFLICT ("boxId")
       DO UPDATE SET "generation" = "box_ssh_access_generation"."generation" + 1, "updatedAt" = now()
       RETURNING "generation"`,
      [boxId],
    )
    return rows[0].generation
  }
}
