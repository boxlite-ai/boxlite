/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm'
import { Box } from './box.entity'

export type TunnelDomainKind = 'platform' | 'custom'

/**
 * A hostname an organization holds, and the box port it currently routes to.
 *
 * The name belongs to the organization for as long as the row exists; the
 * binding is the box port in `box_id` and `port`, and `box_id` alone says
 * whether there is one. It names the port, not its tunnel: a name may be bound
 * before the port is declared public, and several names may route to one port.
 * Unbinding clears both and keeps the name, so the same organization can bind
 * it again while no other can claim it. Deleting the box row clears `box_id`
 * only, which is all a foreign key's SET NULL reaches; the port left beside it
 * is ignored. There is no foreign key to the organization, like `box`.
 */
@Entity('tunnel_domain')
@Unique('tunnel_domain_hostname_unique', ['hostname'])
@Index('tunnel_domain_organization_id_index', ['organizationId'])
@Index('tunnel_domain_target_index', ['boxId', 'port'])
@Check('tunnel_domain_kind', `"kind" IN ('platform', 'custom')`)
@Check('tunnel_domain_target', `("box_id" IS NULL OR "port" IS NOT NULL) AND "port" BETWEEN 1 AND 65535`)
export class TunnelDomain {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'tunnel_domain_id_pk' })
  id: string

  /** The full lowercase hostname, such as `demo.apps.example`. */
  @Column({ type: 'character varying', length: 253 })
  hostname: string

  @Column({ type: 'character varying' })
  kind: TunnelDomainKind

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string

  /** The box this name routes to; null while the name is held but unbound. */
  @Column({ name: 'box_id', type: 'character varying', length: 12, nullable: true })
  boxId: string | null

  /** The port on that box; set whenever `boxId` is, and meaningless when it is not. */
  @Column({ type: 'integer', nullable: true })
  port: number | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone', default: () => 'now()' })
  createdAt: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt: Date

  @ManyToOne(() => Box, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'box_id', foreignKeyConstraintName: 'tunnel_domain_box_id_fk' })
  box?: Box | null
}
