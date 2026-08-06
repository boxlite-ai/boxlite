/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'

/**
 * Durable, ordered snapshot of a Box change that can alter billed usage.
 *
 * Rows are inserted by the database trigger in the same transaction as the Box
 * write.  The usage reconciler applies the row and records processedAt in one
 * ledger transaction, so a crash can neither lose nor double-apply a boundary.
 */
@Entity('box_billing_transitions')
@Index('box_billing_transitions_pending_box_idx', ['boxId', 'id'], {
  where: '"processedAt" IS NULL',
})
@Index('box_billing_transitions_pending_shard_idx', ['runnerId', 'id'], {
  where: '"processedAt" IS NULL',
})
export class BoxBillingTransition {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string

  @Column()
  boxId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column()
  region: string

  @Column({ type: 'uuid', nullable: true })
  runnerId: string | null

  @Column({ type: 'varchar' })
  state: BoxState

  @Column({ type: 'varchar' })
  desiredState: BoxDesiredState

  @Column({ type: 'float' })
  cpu: number

  @Column({ type: 'float' })
  gpu: number

  @Column({ type: 'float' })
  mem: number

  @Column({ type: 'float' })
  disk: number

  @Column({ type: 'boolean' })
  pending: boolean

  @Column({ type: 'timestamp with time zone' })
  occurredAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  processedAt: Date | null
}
