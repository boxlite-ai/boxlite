/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm'
import { Box } from './box.entity'

/**
 * Legacy SSH login-token record. Nothing reads it: the routes, service methods
 * and DTOs were deleted with the token contract, and it is no longer registered
 * in `BoxModule`.
 *
 * It survives on purpose. The migration DataSource globs `**\/*.entity.ts`
 * (`src/migrations/data-source.ts`), so keeping this file stops
 * `migration:generate` emitting a `DROP TABLE "ssh_access"` before the rollback
 * window closes. The table is dropped by the post-deploy contract migration,
 * which must not run until Phase 5 acceptance; this file goes with it.
 */
@Entity()
export class SshAccess {
  @PrimaryColumn()
  @Generated('uuid')
  id: string

  @Column({ name: 'boxId' })
  boxId: string

  @Column({
    type: 'text',
  })
  token: string

  @Column({
    type: 'timestamp',
  })
  expiresAt: Date

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
