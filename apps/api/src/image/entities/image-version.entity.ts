/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm'
import { ImageSourceKind } from '../enums/image-source-kind.enum'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { Image } from './image.entity'

// One row per distinct manifest digest of an image. Rows appear only after a
// pull succeeds, so there is no pending state to go stale: a failed pull is
// recorded on the box that attempted it, not here.
@Entity()
// The same public image reached through two upstream paths is normal usage, so
// the digest is unique per image rather than per organization. This is also
// what makes the registrar's upsert idempotent under concurrent creates.
@Unique('image_version_image_digest_unique', ['imageId', 'digest'])
@Index('image_version_image_state_index', ['imageId', 'state'])
export class ImageVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  imageId: string

  @ManyToOne(() => Image, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'imageId' })
  image: Image

  // The OCI manifest digest reported by the runner: `sha256:` plus 64 hex
  // characters. Not the host's disk cache key, which hashes the layer digest
  // list and would pin a different thing.
  @Column({ type: 'varchar', length: 71 })
  digest: string

  // Sum of the layer sizes the manifest declares. Stored as bigint because a
  // byte count has no business being bounded by int4; the transformer keeps it
  // a number for callers, which is safe well past the download ceiling.
  @Column({
    type: 'bigint',
    transformer: { to: (value: number) => value, from: (value: string) => Number(value) },
  })
  sizeBytes: number

  // Both enum type names are pinned rather than derived, so the migration and
  // the entity name the same Postgres type: TypeORM would otherwise call the
  // second one `image_version_sourcekind_enum`.
  @Column({
    type: 'enum',
    enum: ImageVersionState,
    enumName: 'image_version_state_enum',
    default: ImageVersionState.READY,
  })
  state: ImageVersionState

  @Column({ type: 'enum', enum: ImageSourceKind, enumName: 'image_source_kind_enum' })
  sourceKind: ImageSourceKind

  // What the user actually typed, kept verbatim: `{ sourceRef }`. The tag it
  // names may move upstream, so this is provenance, not an address.
  @Column({ type: 'jsonb' })
  sourceSpec: { sourceRef: string }

  // Where to fetch these bytes from. Today the digest-pinned upstream ref; a
  // gateway path later, without the column changing shape.
  @Column({ type: 'text' })
  storageRef: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
