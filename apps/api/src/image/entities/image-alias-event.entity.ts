/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Image } from './image.entity'
import { ImageVersion } from './image-version.entity'

// Append-only alias registration history; deleting an alias retains its history.
// Explicit storage names preserve the existing migration and deployed data.
@Entity('image_tag_event')
// Ascending, and read backwards for newest first: Postgres walks a btree either
// way, and a DESC index would be a difference `migration:generate` cannot see.
@Index('image_tag_event_image_created_index', ['imageId', 'createdAt'])
export class ImageAliasEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  imageId: string

  @ManyToOne(() => Image, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'imageId' })
  image: Image

  @Column({ name: 'tagName', type: 'varchar', length: 128 })
  aliasName: string

  // Null when the alias did not exist before this event.
  @Column({ type: 'uuid', nullable: true })
  fromVersionId: string | null

  // RESTRICT on both version references, as `image_tag` has: a version the
  // history names must not disappear from under it. Removing the whole image
  // still works, because its cascade removes these rows in the same statement
  // and the check runs at the end of it.
  @ManyToOne(() => ImageVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'fromVersionId' })
  fromVersion: ImageVersion | null

  @Column({ type: 'uuid' })
  toVersionId: string

  @ManyToOne(() => ImageVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'toVersionId' })
  toVersion: ImageVersion

  // Who created it: the user behind the session or API key. Null when a pull
  // recorded the alias rather than an explicit alias creation. A varchar, not a uuid: a
  // user's id is their identity provider's subject.
  @Column({ type: 'varchar', nullable: true })
  actorId: string | null

  // Use write time so concurrent registrations sort by when they were recorded.
  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' })
  createdAt: Date
}
