/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Organization } from './organization.entity'

@Entity()
@Index(['organizationId', 'observedAt'])
export class OrganizationConcurrencySample {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization

  @Column({ type: 'int' })
  runningBoxes: number

  @CreateDateColumn({ type: 'timestamp with time zone' })
  observedAt: Date
}
