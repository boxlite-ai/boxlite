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
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'

// Box-scoped authorization policy object. Deliberately not the legacy
// plaintext-token `SshAccess` row: this is the reusable capability grant an
// app key authenticates against, currently limited to the `ssh` scope.
@Entity()
@Index('box_access_grant_boxid_status_idx', ['boxId', 'status'])
@Index('box_access_grant_secretdigest_idx', ['secretDigest'], { unique: true })
export class BoxAccessGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'boxId' })
  boxId: string

  // Server-keyed digest of the one-time-issued app key. The plaintext value
  // is never persisted or logged.
  @Column({ type: 'text' })
  secretDigest: string

  @Column({
    type: 'enum',
    enum: BoxAccessGrantScope,
    array: true,
  })
  scopes: BoxAccessGrantScope[]

  @Column({
    type: 'enum',
    enum: BoxAccessGrantStatus,
    default: BoxAccessGrantStatus.ACTIVE,
  })
  status: BoxAccessGrantStatus

  @Column({ type: 'timestamp with time zone' })
  expiresAt: Date

  @Column()
  createdBy: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
