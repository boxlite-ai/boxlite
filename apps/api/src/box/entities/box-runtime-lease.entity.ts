/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { BoxState } from '../enums/box-state.enum'

@Entity('box_runtime_lease')
@Index('box_runtime_lease_expiry_idx', ['leaseExpiresAt'])
@Index('box_runtime_lease_runner_idx', ['runnerId'])
export class BoxRuntimeLease {
  @PrimaryColumn({ type: 'character varying', length: 12 })
  boxId: string

  @Column({ type: 'uuid' })
  runnerId: string

  @Column({ type: 'uuid' })
  runnerEpoch: string

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  runtimeGeneration: number

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  sequence: number

  @Column({ type: 'character varying' })
  actualState: BoxState

  @Column({ type: 'timestamp with time zone' })
  observedAt: Date

  @Column({ type: 'timestamp with time zone' })
  leaseExpiresAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
