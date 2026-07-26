/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm'
import { Box } from './box.entity'

/**
 * Public metadata for one issued OpenSSH user certificate.
 *
 * This table holds public material only. The client keeps its private key and
 * the CA private key never leaves the signer boundary, so no column here - now
 * or later - may hold private key material.
 */
@Entity('ssh_certificate_credential')
@Unique('ssh_certificate_credential_organizationId_serial_unique', ['organizationId', 'serial'])
@Index('ssh_certificate_credential_boxId_id_index', ['boxId', 'id'])
export class SshCertificateCredential {
  @PrimaryColumn({ type: 'uuid' })
  id: string

  @Column({ name: 'boxId' })
  boxId: string

  @Column({ type: 'uuid' })
  organizationId: string

  /** Public OpenSSH user certificate: `ssh-ed25519-cert-v01@openssh.com <base64>`. */
  @Column({ type: 'text' })
  certificate: string

  /** Canonical client public key the certificate was issued for. */
  @Column({ type: 'text' })
  publicKey: string

  /** `SHA256:...` fingerprint of `publicKey`, for display and audit. */
  @Column({ type: 'text' })
  fingerprint: string

  /** 64-bit certificate serial, unique within the organization. */
  @Column({ type: 'bigint' })
  serial: string

  /** Non-secret CA key version that signed the certificate. */
  @Column({ type: 'text' })
  caKeyId: string

  @Column({ type: 'timestamp' })
  validAfter: Date

  @Column({ type: 'timestamp' })
  expiresAt: Date

  /**
   * When the API revoked the credential. Revocation hides the
   * credential from the active list; it does not invalidate the already-issued
   * certificate before `expiresAt`.
   */
  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
