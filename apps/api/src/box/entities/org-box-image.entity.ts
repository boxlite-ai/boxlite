/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { OrgBoxImageStatus } from '../enums/org-box-image-status.enum'

@Entity('org_box_image')
@Unique(['organizationId', 'name'])
@Unique(['organizationId', 'ref'])
@Index('org_box_image_organizationid_idx', ['organizationId'])
@Index('org_box_image_status_idx', ['status'])
export class OrgBoxImage {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column()
  name: string

  @Column()
  ref: string

  @Column({
    type: 'enum',
    enum: OrgBoxImageStatus,
    default: OrgBoxImageStatus.ACTIVE,
  })
  status = OrgBoxImageStatus.ACTIVE

  @Column({ nullable: true })
  createdBy?: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
