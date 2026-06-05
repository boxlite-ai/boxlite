/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { BoxTemplate } from './box-template.entity'
import { Region } from '../../region/entities/region.entity'

@Entity()
export class BoxTemplateRegion {
  @PrimaryColumn('uuid')
  templateId: string

  @PrimaryColumn()
  regionId: string

  @ManyToOne(() => BoxTemplate, (template) => template.templateRegions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'templateId' })
  template: BoxTemplate

  @ManyToOne(() => Region, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'regionId' })
  region: Region

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date
}
