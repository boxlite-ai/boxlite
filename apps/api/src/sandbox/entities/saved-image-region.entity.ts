/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { SavedImage } from './saved-image.entity'
import { Region } from '../../region/entities/region.entity'

@Entity()
export class SavedImageRegion {
  @PrimaryColumn('uuid')
  savedImageId: string

  @PrimaryColumn()
  regionId: string

  @ManyToOne(() => SavedImage, (savedImage) => savedImage.savedImageRegions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'savedImageId' })
  savedImage: SavedImage

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
