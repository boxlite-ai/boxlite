/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { Image } from './image.entity'
import { ImageVersion } from './image-version.entity'

// The digest a tag resolved to the first time it was pulled. Nothing moves a
// tag today: once `app:latest` is recorded it keeps pointing at that version.
// The escape hatch is `DELETE /images/:idOrRef` and then using the reference
// again, which brings the name back as a fresh entry. Moving a tag becomes a
// first-class operation later, which is when this table starts changing.
@Entity()
@Unique('image_tag_image_name_unique', ['imageId', 'name'])
// Postgres does not index a foreign key for you, and `versionId` restricts:
// deleting a version scans this table whole for references. That scan is on
// the catalog's delete path, so the index belongs with it.
@Index('image_tag_version_index', ['versionId'])
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
