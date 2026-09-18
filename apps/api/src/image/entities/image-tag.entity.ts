/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { Image } from './image.entity'
import { ImageVersion } from './image-version.entity'

// The digest a tag resolved to the first time it was pulled. S1 never moves a
// tag: once `app:latest` is recorded it keeps pointing at that version, and the
// escape hatch is deleting the image and using it again. Moving a tag becomes a
// first-class operation later, which is when this table starts changing.
@Entity()
@Unique('image_tag_image_name_unique', ['imageId', 'name'])
export class ImageTag {
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

  // RESTRICT, not CASCADE: a version a tag still names must not disappear
  // underneath it, or the tag would resolve to nothing.
  @ManyToOne(() => ImageVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'versionId' })
  version: ImageVersion

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
