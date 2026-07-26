/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

export enum OrganizationSshCaKeyStatus {
  CURRENT = 'current',
  NEXT = 'next',
  RETIRED = 'retired',
}

/**
 * Public metadata for one organization-scoped SSH certificate authority key.
 *
 * The private key stays non-exportable inside the signer provider; only the
 * opaque provider reference and the OpenSSH CA public key are stored here.
 * Rows are provisioned and rotated by the CA rotation runbook.
 */
@Entity('organization_ssh_ca_key')
@Unique('organization_ssh_ca_key_organizationId_keyId_unique', ['organizationId', 'keyId'])
@Index('organization_ssh_ca_key_current_unique', ['organizationId'], {
  unique: true,
  where: `"status" = 'current'`,
})
@Index('organization_ssh_ca_key_next_unique', ['organizationId'], {
  unique: true,
  where: `"status" = 'next'`,
})
export class OrganizationSshCaKey {
  @PrimaryColumn({ type: 'uuid' })
  id: string

  /** Owner of the CA trust domain. */
  @Column({ type: 'uuid' })
  organizationId: string

  /** Stable, non-secret CA key version stamped into every certificate we sign. */
  @Column({ type: 'text' })
  keyId: string

  /** Opaque signer-provider reference (e.g. a KMS key ARN). Never a private key. */
  @Column({ type: 'text' })
  providerKeyRef: string

  /** Canonical OpenSSH CA public key: `ssh-ed25519 <base64>`. Public material only. */
  @Column({ type: 'text' })
  publicKey: string

  @Column({
    type: 'enum',
    enum: OrganizationSshCaKeyStatus,
  })
  status: OrganizationSshCaKeyStatus

  @CreateDateColumn()
  createdAt: Date

  @Column({ type: 'timestamp', nullable: true })
  activatedAt: Date | null

  @Column({ type: 'timestamp', nullable: true })
  retiredAt: Date | null
}
