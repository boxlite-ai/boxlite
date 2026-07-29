/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('runner_runtime_epoch')
@Index('runner_runtime_epoch_current_idx', ['runnerId', 'retiredAt'])
export class RunnerRuntimeEpoch {
  @PrimaryColumn({ type: 'uuid' })
  runnerId: string

  @PrimaryColumn({ type: 'uuid' })
  runnerEpoch: string

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  runnerIncarnation: number

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  lastSequence: number

  @Column({ type: 'timestamp with time zone' })
  activatedAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  retiredAt: Date | null
}
