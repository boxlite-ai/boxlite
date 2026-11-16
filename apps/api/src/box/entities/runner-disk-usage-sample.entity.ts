/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, PrimaryColumn } from 'typeorm'

/**
 * One usage sample of a runner's data disk, bucketed by the expansion cron's
 * sampling interval. Each bucket keeps the maximum usage seen in it, so a
 * short spike between rounds survives into the growth calculation. The growth
 * scan (worst window of `used` over the retention period) reads these rows.
 */
@Entity()
export class RunnerDiskUsageSample {
  @PrimaryColumn('uuid')
  runnerId: string

  /** Bucket start, truncated to the sampling interval. */
  @PrimaryColumn({ type: 'timestamp with time zone' })
  bucketAt: Date

  /** Filesystem `used` (df) as reported in currentAllocatedDiskGiB. */
  @Column('double precision')
  usedGiB: number

  /** Filesystem total (diskGiB) at the time of the sample. */
  @Column('double precision')
  capacityGiB: number
}
