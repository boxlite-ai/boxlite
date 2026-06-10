/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { BoxClass } from '../enums/box-class.enum'

@Entity()
@Index('warm_pool_find_idx', ['template', 'target', 'class', 'cpu', 'mem', 'disk', 'gpu', 'osUser', 'env'])
export class WarmPool {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  pool: number

  // The saved-image migration renamed this column to "savedImage" on the shared dev DB
  // (warm_pool was the only table renamed without a template-compat copy). Keep the TS
  // property name "template" so existing read/write paths are unchanged, but bind it to
  // the actual "savedImage" column so create/start write paths stop hitting
  // `column "WarmPool.template" does not exist`.
  @Column({ name: 'savedImage' })
  template: string

  @Column()
  target: string

  @Column()
  cpu: number

  @Column()
  mem: number

  @Column()
  disk: number

  @Column()
  gpu: number

  @Column()
  gpuType: string

  @Column({
    type: 'enum',
    enum: BoxClass,
    default: BoxClass.SMALL,
  })
  class: BoxClass

  @Column()
  osUser: string

  @Column({ nullable: true })
  errorReason?: string

  @Column({
    type: 'simple-json',
    default: {},
  })
  env: { [key: string]: string }

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date
}
