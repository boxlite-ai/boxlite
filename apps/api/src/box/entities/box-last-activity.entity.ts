/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm'
import { Box } from './box.entity'

@Entity('box_last_activity')
export class BoxLastActivity {
  @PrimaryColumn({ name: 'boxId' })
  boxId: string

  @Column({ nullable: true, type: 'timestamp with time zone' })
  lastActivityAt?: Date

  @OneToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box?: Box
}
