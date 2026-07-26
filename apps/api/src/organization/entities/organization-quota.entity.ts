/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { Organization } from './organization.entity'

/**
 * Per-organization box quota, one row per organization. Kept in its own table
 * (rather than columns on Organization) so quota config has an independent
 * lifecycle and can gain a scope dimension — e.g. per-user rows — without
 * reshaping the Organization entity. A missing row means "org uses the built-in
 * defaults" (see DEFAULT_ORG_QUOTA); it is never treated as "no access".
 */
@Entity()
export class OrganizationQuota {
  @PrimaryColumn()
  organizationId: string

  @OneToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization

  @Column({
    type: 'int',
    default: 64,
    name: 'total_cpu_quota',
  })
  totalCpuQuota: number

  @Column({
    type: 'int',
    default: 256,
    name: 'total_memory_quota',
  })
  totalMemoryQuota: number

  @Column({
    type: 'int',
    default: 512,
    name: 'total_disk_quota',
  })
  totalDiskQuota: number

  @Column({
    type: 'int',
    default: 0,
    name: 'total_gpu_quota',
  })
  totalGpuQuota: number

  @Column({
    type: 'int',
    default: 50,
    name: 'max_concurrent_boxes',
  })
  maxConcurrentBoxes: number

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date
}
