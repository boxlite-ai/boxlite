/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Image } from './image.entity'
import { ImageVersion } from './image-version.entity'

// One row each time a tag comes to point at a version: when a pull first
// records it, and every time someone moves it. Rows are only ever inserted, so
// the image's history is this table read newest first.
@Entity()
// Ascending, and read backwards for newest first: Postgres walks a btree either
// way, and a DESC index would be a difference `migration:generate` cannot see.
@Index('image_tag_event_image_created_index', ['imageId', 'createdAt'])
export class ImageTagEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  imageId: string

  @ManyToOne(() => Image, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'imageId' })
  image: Image

  @Column({ type: 'varchar', length: 128 })
  tagName: string

  // Null when the tag did not exist before this event.
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

  // Who moved it: the user behind the session or API key. Null when a pull
  // recorded the tag rather than anyone moving it. A varchar, not a uuid: a
  // user's id is their identity provider's subject.
  @Column({ type: 'varchar', nullable: true })
  actorId: string | null

  // The moment the row is written, not `now()`, which is when its transaction
  // began. A move writes this after it holds the tag's row lock, so the order
  // of these times is the order the moves took effect — with `now()`, a move
  // that began first but waited for the lock would sort before the one it
  // followed, and the history would name the wrong version as current.
  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' })
  createdAt: Date
}
