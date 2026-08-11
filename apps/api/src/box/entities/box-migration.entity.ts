/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { Box } from './box.entity'

/**
 * A box migration between runners, one row per box being moved.
 *
 * The row is the migration: it appears when the marker claims a parked box and
 * is deleted once the box is no longer migrating, so "not migrating" has a
 * single representation and the table stays the size of the work in flight
 * rather than the size of the fleet. Deleting the box takes the row with it.
 */
@Entity('box_migration')
@Index('box_migration_state_idx', ['state'])
export class BoxMigration {
  @PrimaryColumn({ name: 'boxId' })
  boxId: string

  //  Which migration job this box is waiting on, never what the migration has
  //  produced — that is what `arcPath` and `runnerId` record.
  @Column({
    type: 'enum',
    enum: BoxMigrationState,
  })
  state: BoxMigrationState

  //  Object key of the archive the migration put on the object store. Empty
  //  means there is no archive to reclaim. Written whether or not the migration
  //  stayed valid, because the object exists either way and the rollback path
  //  needs the key to delete it.
  @Column({ type: 'character varying', default: '' })
  arcPath = ''

  //  The second runner a migration involves: before the commit point the runner
  //  the box was imported onto, after it the runner still holding the original
  //  box to discard. Null means no such box exists.
  @Column({
    type: 'uuid',
    nullable: true,
  })
  runnerId?: string

  //  A copy of `box.updatedAt`, taken by every migration step while it holds the
  //  box row, so `box_migration.updatedAt = box.updatedAt` reads as "nothing
  //  outside the migration has touched this box". A write from anywhere else
  //  moves `box.updatedAt` past this copy and breaks the equality, the signal
  //  to roll back. Deliberately the same column type as `box.updatedAt`: a
  //  narrower precision here would round the copy and fail the comparison it
  //  exists for.
  @Column({ type: 'timestamp with time zone' })
  updatedAt: Date

  @OneToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId' })
  box?: Box
}
