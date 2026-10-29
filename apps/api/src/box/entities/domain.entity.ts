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
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm'

export type DomainKind = 'platform' | 'custom'
export type DomainTargetType = 'box' | 'app'
export type DomainTarget = { type: 'box'; box: string; port: number } | { type: 'app'; app: string }

/**
 * A hostname an organization holds, and its typed target.
 *
 * The hostname belongs to the organization for as long as the row exists.
 * `target_type` selects `box_id` or `app_id`; a null selected reference means
 * the hostname is held but unbound. App references are reserved for future use.
 * A Box binding names its port independently of the tunnel's public declaration.
 * Unbinding clears both references and the port, retaining ownership. Box deletion
 * preserves the stored target. Target and organization references have no foreign
 * keys; binding validates the live target, and preview checks whether it is reachable.
 */
@Entity('domain')
@Unique('domain_hostname_unique', ['hostname'])
@Index('domain_organization_id_index', ['organizationId'])
@Index('domain_target_index', ['boxId', 'port'])
@Index('domain_app_target_index', ['appId'])
@Check('domain_kind', `"kind" IN ('platform', 'custom')`)
@Check(
  'domain_target',
  `
  ("target_type" = 'box' AND "app_id" IS NULL
    AND ("box_id" IS NULL OR "port" IS NOT NULL)
    AND ("port" IS NULL OR "port" BETWEEN 1 AND 65535))
  OR ("target_type" = 'app' AND "box_id" IS NULL AND "port" IS NULL
    AND ("app_id" IS NULL OR "app_id" ~ '[^[:space:]]'))
`,
)
export class Domain {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'domain_id_pk' })
  id: string

  /** The full lowercase hostname, such as `demo.apps.example`. */
  @Column({ type: 'character varying', length: 253 })
  hostname: string

  @Column({ type: 'character varying' })
  kind: DomainKind

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string

  @Column({ name: 'target_type', type: 'character varying', default: 'box' })
  targetType: DomainTargetType

  /** Reserved App identity; App binding remains disabled until its resource exists. */
  @Column({ name: 'app_id', type: 'character varying', length: 255, nullable: true })
  appId: string | null

  /** Retained after Box deletion; null for App targets or an unbound Box target. */
  @Column({ name: 'box_id', type: 'character varying', length: 12, nullable: true })
  boxId: string | null

  /** The port on that box; set whenever `boxId` is, and meaningless when it is not. */
  @Column({ type: 'integer', nullable: true })
  port: number | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone', default: () => 'now()' })
  createdAt: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt: Date
}
