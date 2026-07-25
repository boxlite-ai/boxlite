/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm'
import { Box } from './box.entity'
import { BoxSshIdentityStatus } from '../enums/box-ssh-identity-status.enum'

// Host identity last observed from the guest's authenticated control path.
// The private key never leaves the VM; this row only mirrors the public
// half so stop/start and restore/import can detect unexplained rotation.
@Entity()
export class BoxSshIdentity {
  @PrimaryColumn({ name: 'boxId' })
  boxId: string

  @Column({ default: 'ssh-ed25519' })
  algorithm: string

  @Column({ type: 'text' })
  publicKey: string

  @Column()
  fingerprint: string

  // Incremented only on an approved restore/import rotation; never on an
  // unexplained mismatch, which must fail closed instead.
  @Column({ default: 1 })
  identityGeneration: number

  @Column({ type: 'timestamp with time zone' })
  firstSeenAt: Date

  @Column({ type: 'timestamp with time zone' })
  lastSeenAt: Date

  @Column({
    type: 'enum',
    enum: BoxSshIdentityStatus,
    default: BoxSshIdentityStatus.READY,
  })
  status: BoxSshIdentityStatus

  @OneToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
