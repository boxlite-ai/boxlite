/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { Image } from './image.entity'
import { ImageVersion } from './image-version.entity'

// Catalog aliases select ready versions independently of upstream registry tags.
// Explicit storage names preserve the existing migration and deployed data.
@Entity('image_tag')
@Unique('image_tag_image_name_unique', ['imageId', 'name'])
// Postgres does not index a foreign key for you, and `versionId` restricts:
// deleting a version scans this table whole for references. That scan is on
// the catalog's delete path, so the index belongs with it.
@Index('image_tag_version_index', ['versionId'])
export class ImageAlias {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  imageId: string

  @ManyToOne(() => Image, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'imageId' })
  image: Image

  @Column({ type: 'varchar', length: 128 })
  name: string

  @Column({ type: 'uuid' })
  versionId: string

  // RESTRICT, not CASCADE: a version an alias still names must not disappear
  // underneath it, or the alias would resolve to nothing.
  @ManyToOne(() => ImageVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'versionId' })
  version: ImageVersion

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
