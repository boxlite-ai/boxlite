// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm'
import { Box } from './box.entity'

/** Current checkpoint ownership; retain the sequence after releasing the job. */
@Entity('box_checkpoint_state')
export class BoxCheckpointState {
  @PrimaryColumn({ type: 'varchar' })
  boxId: string

  @Column({ type: 'uuid', nullable: true })
  activeJobId: string | null = null

  @Column({ type: 'int', default: 0 })
  sequence = 0

  @OneToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box?: Box
}
