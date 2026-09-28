/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm'
import { Box } from './box.entity'

@Entity('tunnel')
@Unique('tunnel_box_port_unique', ['boxId', 'port'])
@Check('tunnel_port_range', '"port" BETWEEN 1 AND 65535')
@Check(
  'tunnel_mode_token',
  `("access_mode" = 'public' AND "token_hash" IS NULL) OR ("access_mode" = 'private' AND "token_hash" IS NOT NULL)`,
)
export class Tunnel {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'tunnel_id_pk' })
  id: string

  @Column({ name: 'box_id', type: 'character varying', length: 12 })
  boxId: string

  @Column({ type: 'integer' })
  port: number

  @Column({ name: 'access_mode', type: 'character varying' })
  accessMode: 'public' | 'private'

  @Column({ name: 'token_hash', type: 'character varying', nullable: true })
  tokenHash: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone', default: () => 'now()' })
  createdAt: Date

  @Column({ name: 'revoked_at', type: 'timestamp with time zone', nullable: true })
  revokedAt: Date | null

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'box_id', foreignKeyConstraintName: 'tunnel_box_id_fk' })
  box?: Box
}
