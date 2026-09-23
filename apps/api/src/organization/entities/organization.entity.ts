/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { OrganizationUser } from './organization-user.entity'
import { OrganizationRole } from './organization-role.entity'
import { OrganizationInvitation } from './organization-invitation.entity'

@Entity()
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  name: string

  @Column()
  createdBy: string

  @Column({
    default: true,
  })
  telemetryEnabled: boolean

  @Column({ nullable: true })
  defaultRegionId?: string

  @Column({
    type: 'int',
    default: 4,
    name: 'max_cpu_per_box',
  })
  maxCpuPerBox: number

  @Column({
    type: 'int',
    default: 8,
    name: 'max_memory_per_box',
  })
  maxMemoryPerBox: number

  @Column({
    type: 'int',
    default: 10,
    name: 'max_disk_per_box',
  })
  maxDiskPerBox: number

  @Column({
    type: 'int',
    nullable: true,
    name: 'authenticated_rate_limit',
  })
  authenticatedRateLimit: number | null

  @Column({
    type: 'int',
    nullable: true,
    name: 'box_create_rate_limit',
  })
  boxCreateRateLimit: number | null

  @Column({
    type: 'int',
    nullable: true,
    name: 'box_lifecycle_rate_limit',
  })
  boxLifecycleRateLimit: number | null

  @Column({
    type: 'int',
    nullable: true,
    name: 'authenticated_rate_limit_ttl_seconds',
  })
  authenticatedRateLimitTtlSeconds: number | null

  @Column({
    type: 'int',
    nullable: true,
    name: 'box_create_rate_limit_ttl_seconds',
  })
  boxCreateRateLimitTtlSeconds: number | null

  @Column({
    type: 'int',
    nullable: true,
    name: 'box_lifecycle_rate_limit_ttl_seconds',
  })
  boxLifecycleRateLimitTtlSeconds: number | null

  @OneToMany(() => OrganizationRole, (organizationRole) => organizationRole.organization, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  roles: OrganizationRole[]

  @OneToMany(() => OrganizationUser, (user) => user.organization, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  users: OrganizationUser[]

  @OneToMany(() => OrganizationInvitation, (invitation) => invitation.organization, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  invitations: OrganizationInvitation[]

  @Column({
    default: false,
  })
  suspended: boolean

  @Column({
    nullable: true,
    type: 'timestamp with time zone',
  })
  suspendedAt?: Date

  @Column({
    nullable: true,
  })
  suspensionReason?: string

  @Column({
    type: 'int',
    default: 24,
  })
  suspensionCleanupGracePeriodHours: number

  @Column({
    nullable: true,
    type: 'timestamp with time zone',
  })
  suspendedUntil?: Date

  @Column({
    type: 'int',
    default: 20160,
    name: 'template_deactivation_timeout_minutes',
  })
  templateDeactivationTimeoutMinutes: number

  @Column({
    default: false,
  })
  boxLimitedNetworkEgress: boolean

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date

  @Column({
    type: 'jsonb',
    nullable: true,
    name: 'experimentalConfig',
  })
  // configuration for experimental features
  _experimentalConfig: Record<string, any> | null

  get boxMetadata(): Record<string, string> {
    return {
      organizationId: this.id,
      organizationName: this.name,
      limitNetworkEgress: String(this.boxLimitedNetworkEgress),
    }
  }

  constructor(defaultRegionId?: string) {
    if (defaultRegionId) {
      this.defaultRegionId = defaultRegionId
    }
  }
}
