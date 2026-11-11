/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { RunnerDiskExpansionStatus } from '../enums/runner-disk-expansion-status.enum'

/**
 * One data-disk expansion attempt against a runner's cloud disk.
 *
 * `toGiB` is the requested block-device size; `fromGiB` records the
 * runner-reported filesystem total at request time, which sits ~2% below the
 * device (ext4 metadata — the confirmation step's tolerance accounts for
 * it). `accepted` records whether the cloud accepted the request at
 * all: the resize budget counts only accepted requests, so a rejected one
 * (including a GCP rate-limit 400) must not spend it. `operation` is the name
 * of the zone operation GCP returned, used to poll for completion.
 */
@Entity()
@Index(['runnerId', 'requestedAt'])
export class RunnerDiskExpansion {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column('uuid')
  runnerId: string

  @Column('double precision')
  fromGiB: number

  @Column('double precision')
  toGiB: number

  @Column()
  accepted: boolean

  @Column({ type: 'text', nullable: true })
  operation: string | null

  @Column({
    type: 'enum',
    enum: RunnerDiskExpansionStatus,
  })
  status: RunnerDiskExpansionStatus

  @Column({ type: 'text', nullable: true })
  error: string | null

  @Column({ type: 'timestamp with time zone' })
  requestedAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  confirmedAt: Date | null
}
