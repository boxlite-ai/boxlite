/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { Box } from './box.entity'
import { BoxAccessGrant } from './box-access-grant.entity'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'

// Protocol-specific public-key binding synced to the guest's russh listener
// via the Runtime/Runner control facade (`Ssh.ReplaceAccessSet`). `boxId` is
// denormalized from the parent grant so lifecycle cleanup and bounded
// per-box queries don't need a join.
@Entity()
@Index('temporary_ssh_credential_boxid_status_idx', ['boxId', 'status'])
@Index('temporary_ssh_credential_grantid_idx', ['grantId'])
@Index('temporary_ssh_credential_active_dedup_idx', ['boxId', 'publicKeyFingerprint', 'unixUser'], {
  unique: true,
  where: `"status" <> 'REVOKED'`,
})
export class TemporarySshCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'grantId' })
  grantId: string

  @Column({ name: 'boxId' })
  boxId: string

  // Canonical OpenSSH public-key line. Never logged.
  @Column({ type: 'text' })
  publicKey: string

  @Column()
  publicKeyFingerprint: string

  // Fixed to `root` for this design; kept as a column for forward
  // compatibility rather than a hardcoded literal at every call site.
  @Column({ default: 'root' })
  unixUser: string

  @Column({
    type: 'enum',
    enum: TemporarySshCredentialStatus,
    default: TemporarySshCredentialStatus.PENDING,
  })
  status: TemporarySshCredentialStatus

  @Column({ type: 'timestamp with time zone' })
  expiresAt: Date

  @Column()
  createdBy: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date

  @ManyToOne(() => BoxAccessGrant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'grantId' })
  grant: BoxAccessGrant

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
