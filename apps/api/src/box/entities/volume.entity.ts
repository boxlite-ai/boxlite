/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeBackend } from '../enums/volume-backend.enum'

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

  @Column({
    type: 'enum',
    enum: VolumeBackend,
    default: VolumeBackend.S3,
  })
  backend: VolumeBackend

  @Column({ type: 'int', default: 10 })
  sizeGiB: number

  @Column({ nullable: true })
  providerResourceId?: string

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

  public getBucketName(): string {
    return `boxlite-volume-${this.id}`
  }
}
