/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { VolumeState } from '../enums/volume-state.enum'

@Entity()
@Unique(['organizationId', 'name'])
export class Volume {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({
    nullable: true,
    type: 'uuid',
  })
  organizationId?: string

  @Column()
  name: string

  @Column({
    type: 'enum',
    enum: VolumeState,
    default: VolumeState.PENDING_CREATE,
  })
  state: VolumeState

  @Column({ nullable: true })
  errorReason?: string

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date

  @Column({ nullable: true })
  lastUsedAt?: Date

  // Filestore-only: the Filestore instance's logical name in the runner's
  // FILESTORE_INSTANCES configuration that holds the volume's data directory. Null
  // for object-storage volumes, whose data lives in `boxlite-volume-<id>` on
  // the API's own object storage backend. The volume kind is derived: a row
  // with an instance is a filestore volume, without one an object-storage one.
  @Column({ nullable: true })
  instance?: string

  public getBucketName(): string {
    return `boxlite-volume-${this.id}`
  }
}
