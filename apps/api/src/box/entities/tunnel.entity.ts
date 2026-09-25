/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm'
import { Box } from './box.entity'

@Entity('tunnel')
@Unique('tunnel_box_port_unique', ['boxId', 'port'])
export class Tunnel {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'box_id', type: 'character varying', length: 12 })
  boxId: string

  @Column({ type: 'integer' })
  port: number

  @Column({ name: 'access_mode', type: 'character varying' })
  accessMode: 'public' | 'private'

  @Column({ name: 'token_hash', type: 'character varying', nullable: true })
  tokenHash: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date

  @Column({ name: 'revoked_at', type: 'timestamp with time zone', nullable: true })
  revokedAt: Date | null

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'box_id' })
  box?: Box
}
