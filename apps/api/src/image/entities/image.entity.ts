/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

// One row per upstream repository an organization has pulled, created when a
// box built from it reaches STARTED. Curated images are never rows here: they
// stay env-driven so that rotating one does not need a migration, and the
// catalog endpoint will union them in at read time when it ships. No route
// serves this table yet: creating a box reads it, nothing returns it.
@Entity()
// A partial unique index rather than @Unique, so a soft-deleted name can be
// used again. Volume takes the table-level constraint and cannot: its service
// allows the reuse that the constraint then rejects.
@Index('image_org_name_active_unique', ['organizationId', 'name'], { unique: true, where: '"deletedAt" IS NULL' })
// Covers the count the admission gate takes before every cold pull, and the
// per-org listing when the catalog API ships.
@Index('image_org_lastused_index', ['organizationId', 'lastUsedAt'])
export class Image {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  // The upstream repository path, e.g. `docker.io/library/python` — not a
  // short name the user invents. 255 because registry paths are long and the
  // value reaches URLs and route params.
  @Column({ type: 'varchar', length: 255 })
  name: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastUsedAt: Date | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  deletedAt: Date | null
}
