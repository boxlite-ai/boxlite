/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm'
import { RunnerArtifactCache } from './runner-artifact-cache.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { BuildInfo } from './build-info.entity'
import { SavedImageRegion } from './saved-image-region.entity'

@Entity()
@Unique(['organizationId', 'name'])
@Index('saved_image_name_idx', ['name'])
@Index('saved_image_state_idx', ['state'])
export class SavedImage {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({
    nullable: true,
    type: 'uuid',
  })
  organizationId?: string

  // General savedImages are available to all organizations.
  @Column({
    type: 'boolean',
    default: false,
  })
  general = false

  @Column()
  name: string

  @Column({ default: '' })
  imageName: string

  @Column({ nullable: true })
  artifactRef?: string

  @Column({
    type: 'enum',
    enum: SavedImageState,
    default: SavedImageState.PENDING,
  })
  state = SavedImageState.PENDING

  @Column({ nullable: true })
  errorReason?: string

  @Column({ type: 'float', nullable: true })
  size?: number

  @Column({ type: 'int', default: 1 })
  cpu = 1

  @Column({ type: 'int', default: 0 })
  gpu = 0

  @Column({ type: 'int', default: 1 })
  mem = 1

  @Column({ type: 'int', default: 3 })
  disk = 3

  @Column({ type: 'boolean', default: false })
  hideFromUsers = false

  @OneToMany(() => RunnerArtifactCache, (runner) => runner.artifactRef)
  runners: RunnerArtifactCache[]

  @Column({ array: true, type: 'text', nullable: true })
  entrypoint?: string[]

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

  @ManyToOne(() => BuildInfo, (buildInfo) => buildInfo.savedImages, {
    nullable: true,
    eager: true,
  })
  @JoinColumn()
  buildInfo?: BuildInfo

  @Column({ nullable: true })
  initialRunnerId?: string

  @OneToMany(() => SavedImageRegion, (savedImageRegion) => savedImageRegion.savedImage, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  savedImageRegions: SavedImageRegion[]
}
