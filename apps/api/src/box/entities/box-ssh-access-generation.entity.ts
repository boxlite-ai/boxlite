/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { Box } from './box.entity'

// Monotonic per-box counter for full-set `Ssh.ReplaceAccessSet` generations.
// Owned by BoxSshReconciliationService and incremented with an atomic
// upsert (see `nextGeneration`) rather than derived from wall-clock time,
// since two rapid reconcile calls could otherwise tie or regress under
// clock skew.
@Entity()
export class BoxSshAccessGeneration {
  @PrimaryColumn({ name: 'boxId' })
  boxId: string

  @Column({ default: 0 })
  generation: number

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date

  @OneToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box: Box
}
