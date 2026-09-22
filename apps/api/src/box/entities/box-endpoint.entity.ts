/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm'
import { Box } from './box.entity'

@Entity('box_endpoint')
@Index('box_endpoint_organization_idx', ['organizationId'])
@Index('box_endpoint_box_idx', ['boxId'])
export class BoxEndpoint {
  @PrimaryColumn({ type: 'varchar', length: 48 })
  name: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'varchar', length: 12, nullable: true })
  boxId: string | null

  @ManyToOne(() => Box, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'boxId', foreignKeyConstraintName: 'box_endpoint_box_fk' })
  box?: Box

  @Column()
  region: string

  @Column({ type: 'integer' })
  port: number

  @Column()
  url: string

  @Column({ default: true })
  enabled: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
